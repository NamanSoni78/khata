/**
 * TOOLKIT · UNIFIED TOOL-CALL EXTRACTION
 * =======================================
 *
 * Tool calls arrive from TWO places:
 *
 *  1. NATIVE — the provider's structured tool_calls field (OpenAI-compat)
 *     or tool_use blocks (Anthropic). Args arrive as RAW JSON STRINGS
 *     (OpenAI) or objects (Anthropic).
 *
 *  2. INLINE JSON — the model writes {"tool_call":{...}} directly in its
 *     text output. This is the ONLY channel in JSON-fallback mode (models
 *     without native function calling, e.g. Gemma), and a bonus channel in
 *     native mode (models sometimes ignore the tools API and emit JSON
 *     anyway — we catch those too).
 *
 * This module normalizes BOTH into RawToolCall[] and provides:
 *   - balancedBraceScan: finds candidate JSON objects in arbitrary text
 *   - extractInlineToolCalls: {content, calls} with cleaned content
 *   - sanitizeAssistantText: last line of defense so users never see
 *     leaked tool JSON in the chat bubble
 */

import { repairJson, firstBalancedObject } from "./json-repair";
import type { RawToolCall } from "./registry";

/* ------------------------------------------------------------------ */
/* Inline extraction                                                   */
/* ------------------------------------------------------------------ */

export interface InlineExtraction {
  content: string;
  calls: RawToolCall[];
}

/**
 * Extract inline JSON tool calls from assistant text.
 * Handles the documented wrapper AND the flat shape AND batched calls:
 *   {"tool_call":{"name":"log_expense","arguments":{...}}}
 *   {"name":"log_expense","arguments":{...}}
 *   {"tool_calls":[{...},{...}]}
 */
export function extractInlineToolCalls(text: string): InlineExtraction {
  if (!text || !text.includes("{")) return { content: text, calls: [] };

  let remaining = stripFences(text);
  const calls: RawToolCall[] = [];
  let seq = 0;

  // Candidate windows: every balanced {...} object in the text
  let searchFrom = 0;
  while (searchFrom < remaining.length) {
    const start = remaining.indexOf("{", searchFrom);
    if (start === -1) break;
    const candidate = balancedSlice(remaining, start);
    if (!candidate) break; // unbalanced from here on
    const [raw, end] = candidate;

    const parsed = repairJson(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === "object") {
      const extracted = asToolCalls(parsed.value as Record<string, unknown>, seq);
      if (extracted.length > 0) {
        calls.push(...extracted);
        seq += extracted.length;
        // Remove the matched JSON from user-visible content
        remaining = remaining.slice(0, start) + remaining.slice(end + 1);
        searchFrom = start;
        continue;
      }
    }
    searchFrom = end + 1;
  }

  return {
    content: tidyContent(remaining),
    calls,
  };
}

/* ------------------------------------------------------------------ */
/* Native args parsing (raw string → object, with repair)             */
/* ------------------------------------------------------------------ */

/**
 * Parse a native tool-call's arguments field. OpenAI providers ship this
 * as a STRING, and it is frequently malformed. This NEVER throws —
 * on total failure it returns { ok: false } with an error the model can
 * read, enabling the self-correction loop.
 */
export function parseNativeArgs(
  raw: string | Record<string, unknown>
): { ok: true; value: Record<string, unknown>; repairs: string[] } | { ok: false; error: string } {
  if (raw && typeof raw === "object") {
    return { ok: true, value: raw as Record<string, unknown>, repairs: [] };
  }
  if (typeof raw !== "string") {
    return { ok: true, value: {}, repairs: [] };
  }
  const s = raw.trim();
  if (!s || s === "{}") return { ok: true, value: {}, repairs: [] };

  const r = repairJson(s);
  if (r.ok && r.value && typeof r.value === "object" && !Array.isArray(r.value)) {
    return { ok: true, value: r.value as Record<string, unknown>, repairs: r.fixes };
  }
  // Some models emit a bare array of key/value fragments — try object wrap
  if (r.ok && Array.isArray(r.value) && r.value.every((v) => v && typeof v === "object")) {
    const merged: Record<string, unknown> = {};
    for (const item of r.value) Object.assign(merged, item);
    if (Object.keys(merged).length > 0) {
      return { ok: true, value: merged, repairs: [...r.fixes, "merged array of arg objects"] };
    }
  }
  return {
    ok: false,
    error:
      `The arguments you supplied were not valid JSON and could not be repaired automatically ` +
      `(received: ${s.slice(0, 200)}). Call the tool again with clean JSON arguments.`,
  };
}

/* ------------------------------------------------------------------ */
/* Sanitizer — users must never see leaked tool JSON                  */
/* ------------------------------------------------------------------ */

export function sanitizeAssistantText(text: string): string {
  if (!text || !text.includes("{")) return text;

  let out = stripFences(text);
  // Remove any balanced object that parses to a tool-call-ish shape
  let searchFrom = 0;
  while (searchFrom < out.length) {
    const start = out.indexOf("{", searchFrom);
    if (start === -1) break;
    const candidate = balancedSlice(out, start);
    if (!candidate) break;
    const [raw, end] = candidate;
    const parsed = repairJson(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === "object") {
      if (isToolCallShape(parsed.value as Record<string, unknown>)) {
        out = out.slice(0, start) + out.slice(end + 1);
        searchFrom = Math.max(0, start - 1);
        continue;
      }
    }
    searchFrom = end + 1;
  }

  return tidyContent(out);
}

/* ------------------------------------------------------------------ */
/* Shared internals                                                   */
/* ------------------------------------------------------------------ */

/**
 * Balanced {...} slice starting at `start`. Returns [rawText, endIndex]
 * or null when no balanced object starts there (caller advances).
 * Handles nested braces + string states.
 */
function balancedSlice(text: string, start: number): [string, number] | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return [text.slice(start, i + 1), i];
    }
  }
  // Truncated object — take the rest and let repair close it
  const rest = text.slice(start);
  return rest.length > 2 ? [rest, text.length - 1] : null;
}

/** Strip ```fences``` keeping inner content. */
function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, inner: string) => inner.trimEnd() + "\n");
}

function tidyContent(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9]*\s*```/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Does a parsed object look like a tool call? (wrapper OR flat shape) */
function isToolCallShape(v: Record<string, unknown>): boolean {
  const tc = v["tool_call"] ?? v["tool_calls"];
  if (tc && typeof tc === "object") {
    if (Array.isArray(tc)) return tc.some(isToolCallEntry);
    return isToolCallEntry(tc as Record<string, unknown>);
  }
  return isToolCallEntry(v);
}

function isToolCallEntry(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const name = (v as Record<string, unknown>)["name"];
  return typeof name === "string" && TOOL_NAME_RE.test(name);
}

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.\s:-]{2,48}$/;

/* ------------------------------------------------------------------ */
/* Object → RawToolCall[]                                             */
/* ------------------------------------------------------------------ */

function asToolCalls(v: Record<string, unknown>, seq: number): RawToolCall[] {
  const out: RawToolCall[] = [];

  // {"tool_calls":[{name,arguments},...]} — batched form
  const batch = v["tool_calls"];
  if (Array.isArray(batch)) {
    for (const item of batch) {
      const call = entryToCall(item, seq + out.length);
      if (call) out.push(call);
    }
    return out;
  }

  const single = entryToCall(v, seq);
  if (single) out.push(single);
  return out;
}

function entryToCall(v: unknown, seq: number): RawToolCall | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;

  // wrapper: {"tool_call":{name,arguments}}
  const wrapper = obj["tool_call"] ?? obj["function"] ?? obj["fn"];
  let name: unknown;
  let args: unknown;
  if (wrapper && typeof wrapper === "object") {
    name = (wrapper as Record<string, unknown>)["name"];
    args = (wrapper as Record<string, unknown>)["arguments"] ?? (wrapper as Record<string, unknown>)["parameters"] ?? (wrapper as Record<string, unknown>)["args"];
  } else {
    // flat: {"name":..., "arguments":...}
    name = obj["name"] ?? obj["tool"] ?? obj["function_name"];
    args = obj["arguments"] ?? obj["parameters"] ?? obj["args"] ?? obj["input"] ?? {};
  }

  if (typeof name !== "string" || !name.trim()) return null;
  if (!TOOL_NAME_RE.test(name.trim())) return null;

  const id = `tc_${Date.now().toString(36)}_${seq}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    name: name.trim(),
    rawArgs: (args && (typeof args === "object" || typeof args === "string") ? args : {}) as string | Record<string, unknown>,
    source: "inline-json",
  };
}

// Re-export for callers that need the low-level helper
export { firstBalancedObject };
