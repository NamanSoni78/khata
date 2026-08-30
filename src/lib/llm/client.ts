/**
 * Universal LLM client. Supports:
 * - OpenAI-compatible endpoints (Groq, OpenAI, DeepSeek, Together, OpenRouter, LM Studio, etc.)
 * - Anthropic-native API
 *
 * Per-agent config (from AdminConfig DB table) drives:
 * - provider: "openai-compatible" | "anthropic"
 * - baseUrl, apiKey, model
 * - temperature
 * - maxTokensMode: "max_tokens" (standard) | "max_completion_tokens" (o1-style reasoning models)
 * - toolCallingSupported: if false, falls back to structured JSON output via prompt
 *   instructions (parsed by the balanced-brace extractor in json-tool-parser.ts)
 * - extraHeaders: optional JSON object of extra HTTP headers (e.g. OpenRouter's
 *   HTTP-Referer / X-Title, or custom gateway auth headers)
 */
import type { AgentConfig } from "@/lib/admin-config";
import { parseJsonToolCalls } from "./json-tool-parser";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string; // for role="tool" responses
  name?: string; // tool name (for role="tool")
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  raw: unknown;
}

/** Parse the optional extraHeaders from agent config (JSON string OR object) into a headers object. */
function getExtraHeaders(config: AgentConfig): Record<string, string> {
  const raw = (config as AgentConfig & { extraHeaders?: unknown }).extraHeaders;
  if (!raw) return {};
  // Accept either a JSON string (admin UI input) or a pre-parsed object
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

/**
 * Send a chat completion request.
 *
 * If the agent's model doesn't support native function-calling
 * (toolCallingSupported=false) and tools were requested, routes through the
 * JSON-fallback path: tools are documented in the system prompt, tool calls
 * arrive as inline JSON, and tool results are fed back as plain-text turns.
 */
export async function chatComplete(
  config: AgentConfig,
  messages: LLMMessage[],
  tools: ToolDefinition[] = [],
  options: { forceJsonOutput?: boolean } = {}
): Promise<LLMResponse> {
  if (!config.toolCallingSupported && tools.length > 0) {
    return chatCompleteJsonFallback(config, messages, tools, options);
  }
  if (config.provider === "anthropic") {
    return chatCompleteAnthropic(config, messages, tools, options);
  }
  return chatCompleteOpenAICompatible(config, messages, tools, options);
}

// ============================================================
//  JSON tool-call fallback (models without native function-calling)
// ============================================================

async function chatCompleteJsonFallback(
  config: AgentConfig,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  options: { forceJsonOutput?: boolean }
): Promise<LLMResponse> {
  // 1. Flatten the conversation to plain user/assistant turns the model understands:
  //    - assistant turns that carried tool calls -> render the calls as JSON lines
  //    - tool result turns -> user messages with a clear "TOOL RESULT" prefix
  const flattened: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      flattened.push({
        role: "user",
        content: `[TOOL RESULT for ${m.name ?? "tool"}]\n${m.content}`,
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const jsonLines = m.toolCalls
        .map((tc) => JSON.stringify({ tool_call: { name: tc.name, arguments: tc.arguments } }))
        .join("\n");
      flattened.push({ role: "assistant", content: m.content ? `${m.content}\n${jsonLines}` : jsonLines });
    } else {
      flattened.push(m);
    }
  }

  // 2. Inject the strict tool-calling instructions into the system message
  const toolDoc = tools
    .map(
      (t) =>
        `### ${t.function.name}\n${t.function.description}\nArgs schema: ${JSON.stringify(
          t.function.parameters
        )}`
    )
    .join("\n\n");

  const instruct = `

=== TOOL CALLING ===
You have the following tools available. To call a tool, you MUST respond with ONLY valid JSON in this EXACT format — no other text before or after, no markdown, no explanation:

{"tool_call": {"name": "<tool_name>", "arguments": {...}}}

CRITICAL RULES:
1. A tool-call response must be a single JSON object starting with "{" and ending with "}" (one per line).
2. Do NOT wrap the JSON in markdown fences.
3. Do NOT describe the call in any other format. The following is INVALID and will be ignored:
   aggregate
   "group_by": "category"
   "type": "expense"
   Instead, you MUST emit: {"tool_call":{"name":"aggregate","arguments":{"group_by":"category","type":"expense"}}}
4. To call MULTIPLE tools in one turn, emit multiple JSON objects on separate lines:
   {"tool_call":{"name":"log_expense","arguments":{"amount":50,"category":"Food"}}}
   {"tool_call":{"name":"log_expense","arguments":{"amount":20,"category":"Transport"}}}
5. When you receive a "[TOOL RESULT ...]" message, use it to continue the conversation. If all needed tools have been called, reply with a short natural-language summary (no JSON).
6. If you do NOT need to call a tool, respond normally with plain text — no JSON.

WORKED EXAMPLE:
User says: "I spent 200 rs on Zomato today"
Your response (entire content, no markdown, no other text):
{"tool_call": {"name": "log_expense", "arguments": {"amount": 200, "category": "Food", "contact": "Zomato", "notes": "today"}}}

Tools:
${toolDoc}`;

  const withInstructions: LLMMessage[] = [];
  for (const m of flattened) {
    if (m.role === "system" && withInstructions.length === 0) {
      withInstructions.push({ ...m, content: m.content + instruct });
    } else {
      withInstructions.push(m);
    }
  }
  if (withInstructions.length === 0 || withInstructions[0].role !== "system") {
    withInstructions.unshift({ role: "system", content: instruct.trim() });
  }

  // 3. Call the provider WITHOUT native tools
  const providerFn =
    config.provider === "anthropic" ? chatCompleteAnthropic : chatCompleteOpenAICompatible;
  const res = await providerFn(config, withInstructions, [], options);

  // 4. Extract inline JSON tool calls from the text content
  const parsed = parseJsonToolCalls(res.content, true);
  return {
    content: parsed.content,
    toolCalls: parsed.toolCalls as ToolCall[],
    raw: res.raw,
  };
}

// ============================================================
//  OpenAI-compatible (Groq, OpenAI, DeepSeek, OpenRouter, etc.)
// ============================================================

async function chatCompleteOpenAICompatible(
  config: AgentConfig,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  options: { forceJsonOutput?: boolean }
): Promise<LLMResponse> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const useTools = config.toolCallingSupported && tools.length > 0;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(toOpenAIMessage),
    temperature: config.temperature,
    [config.maxTokensMode === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"]:
      config.maxTokens,
  };

  if (useTools) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
    body.tool_choice = "auto";
  } else if (options.forceJsonOutput) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...getExtraHeaders(config),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice) throw new Error("LLM API returned no choices");

  const message = choice.message;
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    arguments:
      typeof tc.function.arguments === "string"
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments,
  }));

  return {
    content: message.content ?? "",
    toolCalls,
    raw: json,
  };
}

function toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content,
      tool_call_id: m.toolCallId,
    };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
  }
  return {
    role: m.role,
    content: m.content,
  };
}

// ============================================================
//  Anthropic-native
// ============================================================

async function chatCompleteAnthropic(
  config: AgentConfig,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  options: { forceJsonOutput?: boolean }
): Promise<LLMResponse> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;

  // Anthropic separates system from user/assistant turns
  const systemMsg = messages.find((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");

  // Convert our messages to Anthropic format. Anthropic supports:
  // - user/assistant turns
  // - tool_use blocks (assistant) + tool_result blocks (user)
  const anthropicMessages: any[] = [];
  for (const m of turns) {
    if (m.role === "tool") {
      // Wrap as a user message with a tool_result block
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      anthropicMessages.push({ role: "assistant", content });
    } else {
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

  if (config.toolCallingSupported && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      ...getExtraHeaders(config),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const blocks = json.content ?? [];
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        name: b.name,
        arguments: b.input,
      });
    }
  }

  return {
    content: text,
    toolCalls,
    raw: json,
  };
}

// ============================================================
//  Test-connection helper (used by admin panel "Test" button)
// ============================================================

export async function testAgentConnection(config: AgentConfig): Promise<{ ok: boolean; message: string }> {
  try {
    if (!config.apiKey) {
      return { ok: false, message: "No API key set — enter one before testing." };
    }
    const res = await chatComplete(
      config,
      [{ role: "user", content: "Reply with the word OK and nothing else." }],
      [],
      {}
    );
    if (res.content.trim().length === 0) {
      return { ok: false, message: "Empty response from model" };
    }
    return { ok: true, message: `Connected. Model: ${config.model}. Sample response: "${res.content.slice(0, 50)}"` };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}

// ============================================================
//  VISION (OCR) — for extracting transactions from images
// ============================================================

export interface VisionImage {
  /** Base64-encoded image bytes (without data: prefix) */
  base64: string;
  /** MIME type, e.g. "image/png", "image/jpeg", "image/webp" */
  mimeType: string;
}

/**
 * Send a vision request — image + text prompt to a multimodal model.
 *
 * Supports:
 *   - "openai-compatible" — gpt-4o / gpt-4-vision via chat completions API
 *   - "anthropic" — claude-3-5-sonnet / claude-3-opus via messages API
 */
export async function chatCompleteVision(
  config: AgentConfig,
  images: VisionImage[],
  textPrompt: string,
  options: { forceJsonOutput?: boolean } = {}
): Promise<LLMResponse> {
  if (config.provider === "anthropic") {
    return chatCompleteVisionAnthropic(config, images, textPrompt);
  }
  return chatCompleteVisionOpenAICompatible(config, images, textPrompt, options);
}

// --- OpenAI-compatible vision ---
async function chatCompleteVisionOpenAICompatible(
  config: AgentConfig,
  images: VisionImage[],
  textPrompt: string,
  options: { forceJsonOutput?: boolean }
): Promise<LLMResponse> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const content: any[] = [{ type: "text", text: textPrompt }];
  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
  }
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "user", content },
    ],
    temperature: config.temperature,
    [config.maxTokensMode === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"]:
      config.maxTokens || 2000,
  };
  if (options.forceJsonOutput) {
    body.response_format = { type: "json_object" };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...getExtraHeaders(config),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vision API error ${res.status}: ${errText}`);
  }
  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice) throw new Error("Vision API returned no choices");
  return {
    content: choice.message?.content ?? "",
    toolCalls: [],
    raw: json,
  };
}

// --- Anthropic vision ---
async function chatCompleteVisionAnthropic(
  config: AgentConfig,
  images: VisionImage[],
  textPrompt: string
): Promise<LLMResponse> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;
  const content: any[] = [];
  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mimeType,
        data: img.base64,
      },
    });
  }
  content.push({ type: "text", text: textPrompt });

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 2000,
    temperature: config.temperature,
    messages: [{ role: "user", content }],
  };
  if (config.systemPrompt) body.system = config.systemPrompt;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      ...getExtraHeaders(config),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic vision API error ${res.status}: ${errText}`);
  }
  const json = await res.json();
  const blocks = json.content ?? [];
  let text = "";
  for (const b of blocks) {
    if (b.type === "text") text += b.text;
  }
  return { content: text, toolCalls: [], raw: json };
}


export async function testSttConnection(config: AgentConfig): Promise<{ ok: boolean; message: string }> {
  try {
    if (!config.baseUrl) {
      return { ok: false, message: "No base URL set." };
    }
    const rawUrl = config.baseUrl.trim().replace(/\/$/, "");
    const sttUrl = rawUrl.endsWith("/audio/transcriptions")
      ? rawUrl
      : `${rawUrl}/audio/transcriptions`;

    const headers: Record<string, string> = {
      ...getExtraHeaders(config),
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const res = await fetch(sttUrl, {
      method: "POST",
      headers,
    });

    if (res.ok || res.status === 400 || res.status === 422 || res.status === 415) {
      return {
        ok: true,
        message: `Connected to STT endpoint (${sttUrl}). Server responded with HTTP ${res.status}.`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Authentication failed (HTTP ${res.status}). Check API key. Endpoint: ${sttUrl}`,
      };
    }

    const text = await res.text().catch(() => "");
    return {
      ok: false,
      message: `STT endpoint error HTTP ${res.status}: ${text.slice(0, 100) || res.statusText}`,
    };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}
