/**
 * JSON tool-call fallback parser.
 *
 * Used when an agent's model does NOT support native function-calling
 * (admin sets "supports tool calling" = OFF in the admin panel — e.g. Gemma
 * and other base/chat models without a tools API). In that mode we instruct
 * the model (via the system prompt) to emit JSON tool calls inline. The model
 * often wraps these in markdown code blocks or surrounds them with reasoning
 * text, so we need a robust extractor that:
 *   1. Strips ```json ... ``` fences (replace with bare inner content)
 *   2. Finds every balanced {...} object in the remaining text
 *   3. Tries to parse each as a { tool_call: { name, arguments } } wrapper
 *   4. Accumulates multiple tool calls (model may batch them)
 *   5. Strips matched JSON blocks from the user-visible content
 *
 * The balanced-brace scanner correctly handles nested JSON like
 * `{"tool_call":{"arguments":{"nodes":[{...},{...}]}}}` which would break a
 * non-greedy regex.
 */

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Strip ```json ... ``` (or ``` ... ```) fenced code blocks from the text.
 * We replace each fenced block with its inner contents (no fences) so the
 * JSON-extraction step can find the bare {...} objects inside.
 *
 * Example: "Here's my plan:\n```json\n{"tool_call":{...}}\n```\nDone."
 *       -> "Here's my plan:\n{"tool_call":{...}}\nDone."
 */
export function stripFencedJsonBlocks(text: string): string {
  const re = /```[a-zA-Z0-9]*\n?([\s\S]*?)```/g;
  return text.replace(re, (_m, inner: string) => inner.trimEnd() + "\n");
}

/**
 * Attempt to repair common LLM JSON quirks before parsing:
 *   - trailing commas before } or ]
 *   - smart quotes used as JSON string delimiters
 *   - literal newlines inside strings are handled fine by JSON.parse only when
 *     escaped; unescaped control chars are escaped here.
 */
function tryParseJson(raw: string): unknown | undefined {
  const attempts = [
    raw,
    // Remove trailing commas: ,} -> } and ,] -> ]
    raw.replace(/,\s*([}\]])/g, "$1"),
    // Smart quotes -> straight quotes
    raw.replace(/[\u201c\u201d]/g, '"').replace(/\u2018|\u2019/g, "'"),
    // Both fixes
    raw
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/,\s*([}\]])/g, "$1"),
  ];
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/**
 * Scan the input text for balanced `{...}` JSON objects.
 * Returns an array of `{ raw, json }` pairs where `raw` is the exact
 * substring matched (including the outer braces), and `json` is the same
 * string (suitable for direct JSON.parse).
 *
 * Strategy:
 *   1. Walk the string char by char, tracking string-literal state + brace depth.
 *   2. When depth returns to 0 after going positive, record the slice.
 *   3. Continue scanning after the closing brace to catch multiple JSON objects.
 *
 * This handles nested braces (e.g., `{"tool_call":{"arguments":{"nodes":[{...}]}}}`)
 * correctly, which a non-greedy regex would break on.
 */
export function extractBalancedJsonObjects(text: string): Array<{ raw: string; json: string }> {
  const out: Array<{ raw: string; json: string }> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    let depth = 0;
    let inStr = false;
    let escape = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escape) { escape = false; continue; }
      if (c === "\\" && inStr) { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break; // unbalanced; stop
    const raw = text.slice(i, end + 1);
    out.push({ raw, json: raw });
    i = end + 1;
  }
  return out;
}

/**
 * Top-level extractor: takes raw LLM content + the agent config flag (whether
 * tools are enabled), and returns the cleaned content + any parsed tool calls.
 *
 * Idempotent + side-effect free — safe to call from any context.
 */
export function parseJsonToolCalls(
  content: string,
  useTools: boolean
): { content: string; toolCalls: ParsedToolCall[] } {
  if (!useTools) return { content, toolCalls: [] };

  let text = stripFencedJsonBlocks(content);
  const matches = extractBalancedJsonObjects(text);
  const toolCalls: ParsedToolCall[] = [];

  for (const { raw } of matches) {
    const parsed = tryParseJson(raw) as
      | { tool_call?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown }
      | undefined;
    if (parsed) {
      // Accept BOTH the documented {"tool_call":{name,arguments}} wrapper AND
      // the flat {"name":...,"arguments":...} shape some models emit.
      const name =
        (parsed.tool_call && typeof parsed.tool_call.name === "string" && parsed.tool_call.name) ||
        (typeof parsed.name === "string" && parsed.name) ||
        null;
      const args =
        (parsed.tool_call && parsed.tool_call.arguments) ||
        parsed.arguments ||
        {};
      if (name && typeof name === "string" && KNOWN_TOOL_NAME_HINT.test(name)) {
        toolCalls.push({
          id: `json_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${toolCalls.length}`,
          name,
          arguments: (args as Record<string, unknown>) ?? {},
        });
        // Strip the matched JSON block from the user-visible content
        text = text.replace(raw, "");
      }
    }
    // Not a valid tool_call wrapper — leave it in content.
  }

  return {
    content: text.replace(/\n{3,}/g, "\n\n").trim(),
    toolCalls,
  };
}

/**
 * Heuristic: a parsed object is only treated as a tool call when its name
 * looks like one of our tools (snake_case identifier). Prevents random JSON
 * objects (chart specs, user data) from being swallowed as tool calls.
 */
const KNOWN_TOOL_NAME_HINT = /^[a-z][a-z0-9_]{2,40}$/;

/**
 * LAST-LINE-OF-DEFENSE sanitizer for user-visible assistant text.
 *
 * Even with the parser above, models occasionally leak a tool-call JSON in the
 * FINAL text reply (e.g. when the loop hits the iteration cap and the last
 * content still carries the JSON, or when the model re-states the call as an
 * example). Users should NEVER see raw {"tool_call":...} in the chat bubble.
 *
 * This strips:
 *   - any balanced {"tool_call":{...}} / {"name":...,"arguments":...} objects
 *     (also inside code fences),
 *   - leftover fenced blocks that contain nothing but a tool call,
 *   - the "[CHART:{...}]" marker is NOT touched here (handled separately).
 */
export function sanitizeAssistantText(text: string): string {
  if (!text || !text.includes("{")) return text;

  let out = stripFencedJsonBlocks(text);
  const objs = extractBalancedJsonObjects(out);
  for (const { raw } of objs) {
    const parsed = tryParseJson(raw) as any;
    if (
      parsed &&
      ((parsed.tool_call && typeof parsed.tool_call.name === "string") ||
        (typeof parsed.name === "string" &&
          typeof parsed.arguments === "object" &&
          KNOWN_TOOL_NAME_HINT.test(parsed.name)))
    ) {
      out = out.split(raw).join("");
    }
  }
  // Clean orphaned fence remnants + excess blank lines
  out = out
    .replace(/```[a-zA-Z0-9]*\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}
