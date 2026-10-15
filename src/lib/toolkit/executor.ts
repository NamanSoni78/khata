/**
 * TOOLKIT · SAFE EXECUTOR
 * ========================
 *
 * Executes ONE tool call through every safety layer:
 *
 *   raw call → [name resolution (fuzzy)] → [args repair (JSON)]
 *            → [schema validation + coercion] → [timeout-wrapped run]
 *            → ToolOutcome
 *
 * The ToolOutcome is an ALWAYS-VALID envelope. When something is wrong the
 * outcome carries a `feedback` string written FOR THE MODEL, so the agent
 * loop can send it back as the tool result and the model self-corrects.
 * Nothing here ever throws.
 */

import type { ToolRegistry, ToolContext, RawToolCall } from "./registry";
import { parseNativeArgs, extractInlineToolCalls } from "./parse";
import { validateAndCoerce, type ValidationOutcome } from "./schema";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ToolOutcome {
  /** Tool-call id passed through (echoed back to the provider). */
  id: string;
  /** Canonical tool name (after fuzzy resolution). */
  toolName: string;
  /** true when the tool implementation actually ran. */
  executed: boolean;
  /** Final args (repaired + coerced) — undefined when parsing failed. */
  args?: Record<string, unknown>;
  /** The result string (tool output OR model-facing feedback). */
  result: string;
  /** Everything that went wrong — for logs/diagnostics, not the model. */
  diagnostics: string[];
  /** Name/args repairs applied (for logs). */
  repairs: string[];
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_TOOL_TIMEOUT_MS = 20_000;

export async function executeToolCall(
  registry: ToolRegistry,
  call: RawToolCall,
  ctx: ToolContext,
  opts: { timeoutMs?: number } = {}
): Promise<ToolOutcome> {
  const diagnostics: string[] = [];
  const repairs: string[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  /* ---------- 1. Resolve the tool name ---------- */
  const resolved = registry.resolve(call.name);
  if (!resolved) {
    const available = registry.names();
    return {
      id: call.id,
      toolName: call.name,
      executed: false,
      result:
        `ERROR: unknown tool "${call.name}". ` +
        `Available tools: ${available.join(", ")}. ` +
        `Call one of these with the correct name.`,
      diagnostics: [`unresolved tool name: ${call.name}`],
      repairs,
    };
  }
  if (!resolved.exact) {
    repairs.push(`tool name corrected: "${call.name}" → "${resolved.tool.name}"`);
  }

  /* ---------- 2. Repair + parse arguments ---------- */
  const parsed = parseNativeArgs(call.rawArgs);
  if (!parsed.ok) {
    return {
      id: call.id,
      toolName: resolved.tool.name,
      executed: false,
      result: `ERROR in tool "${resolved.tool.name}": ${parsed.error}`,
      diagnostics: [`args unparseable: ${String(call.rawArgs).slice(0, 200)}`],
      repairs,
    };
  }
  if (parsed.repairs.length > 0) {
    repairs.push(...parsed.repairs);
  }

  /* ---------- 3. Validate + coerce against the schema ---------- */
  let validation: ValidationOutcome;
  try {
    validation = validateAndCoerce(parsed.value, resolved.tool.parameters as Record<string, unknown>);
  } catch (e) {
    // Validator itself must never take the turn down
    validation = {
      ok: true,
      value: parsed.value,
      errors: [],
      warnings: [`validator crashed (${String(e)}); passing raw args`],
    };
  }
  if (validation.errors.length > 0) {
    return {
      id: call.id,
      toolName: resolved.tool.name,
      executed: false,
      result:
        `ERROR in tool "${resolved.tool.name}" arguments:\n` +
        validation.errors.map((e) => `- ${e}`).join("\n") +
        `\nFix the arguments and call "${resolved.tool.name}" again.`,
      args: parsed.value,
      diagnostics: validation.errors,
      repairs,
    };
  }
  if (validation.warnings.length > 0) {
    repairs.push(...validation.warnings);
  }

  /* ---------- 4. Run with a timeout ---------- */
  try {
    const result = await withTimeout(
      Promise.resolve(resolved.tool.execute(validation.value, ctx)).then((r) => String(r ?? "")),
      timeoutMs,
      `Tool "${resolved.tool.name}" timed out after ${timeoutMs / 1000}s`
    );
    return {
      id: call.id,
      toolName: resolved.tool.name,
      executed: true,
      args: validation.value,
      result: result || "(tool returned an empty result)",
      diagnostics: [],
      repairs,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostics.push(`tool threw: ${msg}`);
    return {
      id: call.id,
      toolName: resolved.tool.name,
      executed: false,
      args: validation.value,
      result: `ERROR: tool "${resolved.tool.name}" failed — ${msg}. Tell the user this action didn't complete.`,
      diagnostics,
      repairs,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Belt-and-braces: scan an assistant's TEXT content for inline JSON tool
 * calls even in native mode (some models bypass the tools API). Only
 * returns calls whose names resolve to known tools — random JSON (chart
 * specs etc.) is never swallowed.
 */
export function mineInlineCalls(
  registry: ToolRegistry,
  content: string
): { calls: RawToolCall[]; cleanedContent: string } {
  const { calls, content: cleaned } = extractInlineToolCalls(content);
  const known = calls.filter((c) => registry.resolve(c.name) !== null);
  return { calls: known, cleanedContent: cleaned };
}
