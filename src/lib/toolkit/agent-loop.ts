/**
 * TOOLKIT · RESILIENT AGENT LOOP
 * ================================
 *
 * The orchestrator that makes tool calling "never fail". Every failure
 * mode has a handler:
 *
 *   Provider 4xx "tools not supported"  → auto-degrade to JSON-mode, retry
 *   Malformed native args               → JSON repair, then coercion
 *   Hallucinated tool name              → fuzzy resolution, else feedback
 *   Invalid args (schema)               → precise feedback → model retries
 *   Duplicate/looped calls              → dedup guard + stuck detection
 *   Tool crash / hang                   → timeout + error envelope
 *   Model writes JSON in text (native)  → inline-call mining
 *
 * The loop NEVER throws for tool-related reasons. It only propagates
 * genuine provider/transport failures (already retried upstream).
 */

import type { AgentConfig } from "@/lib/admin-config";
import {
  callProvider,
  buildJsonModeConversation,
  isToolUnsupportedError,
  type ToolkitMessage,
  type ToolkitToolCall,
} from "./providers";
import type { ToolRegistry, ToolContext, RawToolCall } from "./registry";
import { executeToolCall, mineInlineCalls, type ToolOutcome } from "./executor";
import { extractInlineToolCalls, sanitizeAssistantText } from "./parse";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ExecutedCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  executed: boolean;
}

export interface LoopResult {
  /** Final user-visible assistant text (sanitized). */
  finalContent: string;
  /** Every tool call attempted this run (executed or not). */
  toolCalls: ExecutedCall[];
  /** Provider-mode that produced the final answer. */
  mode: "native" | "json";
  /** true when we auto-degraded native → json mid-run. */
  degraded: boolean;
  iterations: number;
  /** Everything noteworthy that happened (for admin logs). */
  diagnostics: string[];
}

export interface LoopOptions {
  config: AgentConfig;
  /** Full conversation including the system prompt + new user message. */
  messages: ToolkitMessage[];
  registry: ToolRegistry;
  ctx: ToolContext;
  maxIterations?: number;
  toolTimeoutMs?: number;
}

const DEFAULT_MAX_ITERATIONS = 6;
const MAX_CONSECUTIVE_FAILED_CALLS = 3;

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

export async function runToolLoop(opts: LoopOptions): Promise<LoopResult> {
  const { config, messages, registry, ctx } = opts;
  const maxIterations = Math.max(1, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS);

  const diagnostics: string[] = [];
  const toolCalls: ExecutedCall[] = [];

  let mode: "native" | "json" = config.toolCallingSupported ? "native" : "json";
  let degraded = false;
  let iteration = 0;
  let finalContent = "";
  let consecutiveFailed = 0;

  // Dedup guard: same (name + canonical args) never dispatches twice.
  const dispatchedKeys = new Set<string>();

  while (iteration < maxIterations) {
    iteration++;

    /* ---------- Call the provider (with auto-degradation) ---------- */
    let res;
    try {
      if (mode === "json") {
        const flat = buildJsonModeConversation(messages, registry.list());
        res = await callProvider(config, flat, { mode: "json", tools: registry.list() });
      } else {
        res = await callProvider(config, messages, { mode: "native", tools: registry.list() });
      }
    } catch (e) {
      // One-shot auto-degrade: endpoint rejects the tools parameter
      if (mode === "native" && isToolUnsupportedError(e)) {
        mode = "json";
        degraded = true;
        diagnostics.push(
          `endpoint rejected native tools (${e instanceof Error ? e.message.slice(0, 120) : e}) — auto-degraded to JSON mode`
        );
        iteration--; // don't count the burned attempt
        continue;
      }
      throw e; // transport already retried; genuine failure
    }

    /* ---------- Collect tool calls from both channels ---------- */
    let content: string = res.content;
    const calls: RawToolCall[] = [...res.rawCalls];

    if (calls.length === 0 || mode === "json") {
      // Mine inline JSON calls from the text content.
      // In json mode this is THE channel; in native mode it catches models
      // that bypass the tools API. Only known tool names are accepted.
      const mined = mineInlineCalls(registry, content);
      if (mined.calls.length > 0) {
        calls.push(...mined.calls);
        content = mined.cleanedContent;
        if (mode === "native") {
          diagnostics.push(`mined ${mined.calls.length} inline JSON tool call(s) from native-mode text`);
        }
      } else if (mode === "json") {
        // clean content even when nothing was mined (fences etc.)
        content = extractInlineToolCalls(content).content;
      }
    }

    /* ---------- No tool calls → final answer ---------- */
    if (calls.length === 0) {
      finalContent = sanitizeAssistantText(content);
      if (!finalContent && iteration === 1) {
        // Model returned nothing at all — nudge once
        diagnostics.push("empty first response — nudging");
        messages.push({ role: "user", content: "(Please answer the last question.)" });
        continue;
      }
      break;
    }

    /* ---------- Dedup filter ---------- */
    const unique: RawToolCall[] = [];
    for (const c of calls) {
      const key = `${c.name}::${stableArgsKey(c.rawArgs)}`;
      if (dispatchedKeys.has(key)) {
        diagnostics.push(`skipped duplicate call ${c.name} (same args already dispatched)`);
        continue;
      }
      dispatchedKeys.add(key);
      unique.push(c);
    }

    if (unique.length === 0) {
      // Everything this round was a duplicate → model is stuck in a loop
      diagnostics.push("all calls this round were duplicates — stopping");
      finalContent = sanitizeAssistantText(content) || "Done.";
      break;
    }

    /* ---------- Echo the assistant's tool-call turn ---------- */
    // Args may be raw strings here; the provider adapters stringify objects
    // when echoing, so we pre-parse safely (best-effort, never throws).
    const echoCalls: ToolkitToolCall[] = unique.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: asArgsObject(c.rawArgs),
    }));
    messages.push({
      role: "assistant",
      content: sanitizeAssistantText(content),
      toolCalls: echoCalls,
    });

    /* ---------- Execute each call ---------- */
    let anyExecuted = false;
    for (const c of unique) {
      const outcome: ToolOutcome = await executeToolCall(registry, c, ctx, {
        timeoutMs: opts.toolTimeoutMs,
      });
      toolCalls.push({
        name: outcome.toolName,
        args: outcome.args ?? {},
        result: outcome.result,
        executed: outcome.executed,
      });
      if (outcome.repairs.length > 0) {
        diagnostics.push(`[${outcome.toolName}] ${outcome.repairs.join("; ")}`);
      }
      if (outcome.executed) {
        anyExecuted = true;
      }
      messages.push({
        role: "tool",
        content: outcome.result,
        toolCallId: outcome.id,
        name: outcome.toolName,
      });
    }

    // Track consecutive rounds where NOTHING executed (model keeps
    // producing unfixable calls) — bail gracefully instead of looping.
    if (anyExecuted) {
      consecutiveFailed = 0;
    } else {
      consecutiveFailed++;
      if (consecutiveFailed >= MAX_CONSECUTIVE_FAILED_CALLS) {
        diagnostics.push(`${consecutiveFailed} consecutive rounds of unexecutable calls — stopping`);
        finalContent =
          "I ran into trouble completing that action. Could you rephrase or try again?";
        break;
      }
    }

    finalContent = sanitizeAssistantText(content);
    // continue → model sees tool results and produces the next turn
  }

  if (iteration >= maxIterations && !finalContent) {
    finalContent = "That took too many steps — I stopped to avoid going in circles. Could you rephrase?";
    diagnostics.push(`hit max iterations (${maxIterations})`);
  }

  return { finalContent, toolCalls, mode, degraded, iterations: iteration, diagnostics };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Stable, order-independent key for dedup. */
function stableArgsKey(raw: string | Record<string, unknown>): string {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    // Best-effort parse; if unparseable use the raw text
    try {
      obj = JSON.parse(raw);
    } catch {
      return raw.slice(0, 200);
    }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[k] = (obj as Record<string, unknown>)[k];
    }
    try {
      return JSON.stringify(sorted);
    } catch {
      return "unstringifiable";
    }
  }
  return String(obj);
}

/** Raw args (string or object) → object, never throws. */
function asArgsObject(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}
