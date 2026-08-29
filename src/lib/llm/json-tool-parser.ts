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
    try {
      const parsed = JSON.parse(raw) as { tool_call?: { name?: string; arguments?: unknown } };
      if (parsed?.tool_call?.name && typeof parsed.tool_call.name === "string") {
        toolCalls.push({
          id: `json_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${toolCalls.length}`,
          name: parsed.tool_call.name,
          arguments: (parsed.tool_call.arguments as Record<string, unknown>) ?? {},
        });
        // Strip the matched JSON block from the user-visible content
        text = text.replace(raw, "");
      }
    } catch {
      // Not a valid tool_call wrapper — leave it in content.
    }
  }

  return {
    content: text.replace(/\n{3,}/g, "\n\n").trim(),
    toolCalls,
  };
}
