/**
 * TOOLKIT · PROVIDERS
 * ====================
 *
 * Transport-level adapters for the two provider families:
 *   - OpenAI-compatible (OpenAI, Groq, DeepSeek, OpenRouter, Together, LM Studio…)
 *   - Anthropic-native
 *
 * Key "never fail" behaviors:
 *   - All HTTP goes through fetchWithRetry (timeout + backoff)
 *   - Native tool-call ARGUMENTS ARE KEPT AS RAW STRINGS — never
 *     JSON.parse'd here. The parse layer repairs them, so malformed
 *     args can't crash the turn.
 *   - `isToolUnsupportedError()` detects providers that reject the
 *     `tools` parameter outright, letting the agent loop auto-degrade
 *     to JSON-mode for the rest of the run.
 *   - In native mode we ALSO scan the text content for inline
 *     {"tool_call":...} JSON — models sometimes bypass the tools API.
 */

import type { AgentConfig } from "@/lib/admin-config";
import { fetchWithRetry, readErrorMessage } from "./transport";
import type { RawToolCall } from "./registry";
import type { ToolSpec } from "./registry";

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export interface ToolkitToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolkitMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolkitToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name?: string };

export interface ProviderResult {
  content: string;
  /** Native tool calls (args still raw). */
  rawCalls: RawToolCall[];
  raw: unknown;
}

export interface CallOptions {
  /** "native" = provider tools API; "json" = prompt-injected tool doc. */
  mode: "native" | "json";
  tools: ToolSpec[];
  forceJsonOutput?: boolean;
}

/* ------------------------------------------------------------------ */
/* Public entry                                                        */
/* ------------------------------------------------------------------ */

export async function callProvider(
  config: AgentConfig,
  messages: ToolkitMessage[],
  opts: CallOptions
): Promise<ProviderResult> {
  const providerFn = config.provider === "anthropic" ? callAnthropic : callOpenAICompatible;
  return providerFn(config, messages, opts);
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible                                                   */
/* ------------------------------------------------------------------ */

async function callOpenAICompatible(
  config: AgentConfig,
  messages: ToolkitMessage[],
  opts: CallOptions
): Promise<ProviderResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const useNativeTools = opts.mode === "native" && opts.tools.length > 0;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(toOpenAIMessage),
    temperature: config.temperature,
    [config.maxTokensMode === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"]:
      config.maxTokens,
  };

  if (useNativeTools) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  } else if (opts.forceJsonOutput) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...parseExtraHeaders(config),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw new ProviderError(msg, res.status);
  }

  const json = await res.json();
  const choice = json?.choices?.[0];
  if (!choice?.message) {
    throw new ProviderError("Model returned no choices", 0);
  }

  const message = choice.message;
  const rawCalls: RawToolCall[] = [];

  // Native tool calls — args kept as RAW STRINGS for the repair layer
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const fn = tc?.function;
      const name = fn?.name;
      if (typeof name !== "string" || !name.trim()) continue;
      rawCalls.push({
        id: typeof tc.id === "string" && tc.id ? tc.id : `native_${Math.random().toString(36).slice(2, 10)}`,
        name: name.trim(),
        rawArgs: typeof fn.arguments === "string" ? fn.arguments : (fn.arguments ?? {}),
        source: "native",
      });
    }
  }

  return {
    content: typeof message.content === "string" ? message.content : "",
    rawCalls,
    raw: json,
  };
}

function toOpenAIMessage(m: ToolkitMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/* ------------------------------------------------------------------ */
/* Anthropic-native                                                    */
/* ------------------------------------------------------------------ */

async function callAnthropic(
  config: AgentConfig,
  messages: ToolkitMessage[],
  opts: CallOptions
): Promise<ProviderResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/messages`;
  const useNativeTools = opts.mode === "native" && opts.tools.length > 0;

  const systemMsg = messages.find((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");

  const anthropicMessages: unknown[] = [];
  for (const m of turns) {
    if (m.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      anthropicMessages.push({ role: "assistant", content });
    } else if (m.role === "assistant" || m.role === "user") {
      anthropicMessages.push({ role: m.role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    messages: anthropicMessages,
  };
  if (systemMsg) body.system = systemMsg.content;
  if (useNativeTools) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
      "anthropic-version": "2023-06-01",
      ...parseExtraHeaders(config),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw new ProviderError(msg, res.status);
  }

  const json = await res.json();
  const blocks = Array.isArray(json?.content) ? json.content : [];
  let text = "";
  const rawCalls: RawToolCall[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
    else if (b?.type === "tool_use" && typeof b.name === "string") {
      rawCalls.push({
        id: typeof b.id === "string" ? b.id : `native_${Math.random().toString(36).slice(2, 10)}`,
        name: b.name,
        rawArgs: (b.input ?? {}) as Record<string, unknown>,
        source: "native",
      });
    }
  }

  return { content: text, rawCalls, raw: json };
}

/* ------------------------------------------------------------------ */
/* Errors + degradation detection                                      */
/* ------------------------------------------------------------------ */

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/**
 * Detect "this model/endpoint doesn't support the tools parameter" errors
 * so the agent loop can auto-degrade to JSON-mode and RETRY rather than fail.
 *
 * Typical bodies:
 *   - OpenAI:    "tools is not supported by this model"
 *   - Groq:      "…does not support tool/function calling"
 *   - OpenRouter:"no endpoints found that support tool use"
 *   - vLLM/Ollama variants, 404 unknown parameter, 400 invalid request
 */
export function isToolUnsupportedError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.status !== 400 && err.status !== 404 && err.status !== 422) return false;
  return /tool|function[ _-]?call|function[ _-]?us/i.test(err.message);
}

/* ------------------------------------------------------------------ */
/* JSON-mode (prompt-injected tool calling)                            */
/* ------------------------------------------------------------------ */

/**
 * Flatten a toolkit conversation into plain user/assistant turns any model
 * can follow, and append the strict JSON tool-calling instructions to the
 * system prompt. Used when mode="json" (admin toggle OR auto-degradation).
 */
export function buildJsonModeConversation(
  messages: ToolkitMessage[],
  tools: ToolSpec[]
): ToolkitMessage[] {
  // 1. Flatten
  const flat: ToolkitMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      flat.push({
        role: "user",
        content: `[TOOL RESULT for ${m.name ?? "tool"}]\n${m.content}`,
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const jsonLines = m.toolCalls
        .map((tc) => JSON.stringify({ tool_call: { name: tc.name, arguments: tc.arguments } }))
        .join("\n");
      flat.push({
        role: "assistant",
        content: m.content ? `${m.content}\n${jsonLines}` : jsonLines,
      });
    } else {
      flat.push(m);
    }
  }

  // 2. Compact tool documentation (name + description + arg names with types,
  //    NOT the full JSON schema — small models follow examples better than schemas)
  const toolDoc = tools
    .map((t) => {
      const props = (t.parameters as { properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }> }).properties ?? {};
      const req = (t.parameters as { required?: string[] }).required ?? [];
      const argList = Object.entries(props)
        .map(([k, p]) => `${k}${req.includes(k) ? "" : "?"}:${p.type ?? "any"}${p.enum ? ` (${p.enum.join("|")})` : ""}`)
        .join(", ");
      return `- ${t.name}(${argList}) — ${t.description}`;
    })
    .join("\n");

  const instruct = `

=== TOOL CALLING ===
You have these tools:

${toolDoc}

To call a tool, respond with ONLY this JSON — no other text, no markdown fences:
{"tool_call": {"name": "<tool_name>", "arguments": {...}}}

RULES:
1. One JSON object per tool call. For multiple calls, emit multiple JSON objects on separate lines.
2. Arguments must be valid JSON matching the documented types.
3. After you receive a "[TOOL RESULT ...]" message, use it. When you have all the results you need, reply with a short natural-language answer (no JSON).
4. If no tool is needed, just answer normally in plain text.

EXAMPLE:
User: "I spent 200 rs on Zomato today"
Your entire response:
{"tool_call": {"name": "log_expense", "arguments": {"amount": 200, "category": "Food", "contact": "Zomato"}}}`;

  // 3. Inject into the system prompt
  const out: ToolkitMessage[] = [];
  for (const m of flat) {
    if (m.role === "system" && out.length === 0) {
      out.push({ role: "system", content: m.content + instruct });
    } else {
      out.push(m);
    }
  }
  if (out.length === 0 || out[0].role !== "system") {
    out.unshift({ role: "system", content: instruct.trim() });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function parseExtraHeaders(config: AgentConfig): Record<string, string> {
  const raw = config.extraHeaders;
  if (!raw) return {};
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  return {};
}
