/**
 * Universal LLM client — now a thin facade over the internal tool-calling
 * SDK (`src/lib/toolkit/`). Every request goes through the SDK's transport
 * (timeout + retry/backoff), and tool-call arguments are always parsed
 * through the repair layer — never a raw JSON.parse that can throw.
 *
 * Public API (unchanged for existing callers):
 *   - chatComplete(config, messages, tools?, options?) → LLMResponse
 *   - chatCompleteVision(config, images, prompt, options?) → LLMResponse
 *   - testAgentConnection / testSttConnection / resolveSttUrl
 *   - Types: LLMMessage, ToolCall, ToolDefinition, LLMResponse, VisionImage
 *
 * The agent LOOP itself now lives in the toolkit (runToolLoop) and is
 * orchestrated by src/lib/agent/loop.ts, which adds chat persistence.
 */
import type { AgentConfig } from "@/lib/admin-config";
import {
  callProvider,
  isToolUnsupportedError,
  parseExtraHeaders,
  type ToolkitMessage,
} from "@/lib/toolkit/providers";
import { fetchWithRetry, readErrorMessage } from "@/lib/toolkit/transport";
import { parseNativeArgs } from "@/lib/toolkit/parse";
import { extractInlineToolCalls } from "@/lib/toolkit/parse";
import type { ToolSpec } from "@/lib/toolkit/registry";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
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
    parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  raw: unknown;
}

/* ------------------------------------------------------------------ */
/* Chat completions                                                    */
/* ------------------------------------------------------------------ */

/**
 * Send a chat completion request. When `tools` are provided (rare — the
 * agent loop uses runToolLoop directly), native tool-calling is attempted
 * with automatic JSON-mode degradation, and arguments are always repaired.
 */
export async function chatComplete(
  config: AgentConfig,
  messages: LLMMessage[],
  tools: ToolDefinition[] = [],
  options: { forceJsonOutput?: boolean } = {}
): Promise<LLMResponse> {
  const toolkitMessages = messages.map(toToolkitMessage);
  const specs: ToolSpec[] = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    execute: () => "(not executable via chatComplete — use runToolLoop)",
  }));

  let mode: "native" | "json" = config.toolCallingSupported && tools.length > 0 ? "native" : "native";

  // One-shot auto-degrade when the endpoint rejects the tools parameter
  let res;
  try {
    res = await callProvider(config, toolkitMessages, {
      mode,
      tools: specs,
      forceJsonOutput: options.forceJsonOutput,
    });
  } catch (e) {
    if (tools.length > 0 && mode === "native" && isToolUnsupportedError(e)) {
      mode = "json";
      const { buildJsonModeConversation } = await import("@/lib/toolkit/providers");
      const flat = buildJsonModeConversation(toolkitMessages, specs);
      res = await callProvider(config, flat, { mode: "json", tools: specs, forceJsonOutput: options.forceJsonOutput });
    } else {
      throw e;
    }
  }

  // Parse native calls — REPAIRED, never a raw JSON.parse
  const toolCalls: ToolCall[] = [];
  for (const rc of res.rawCalls) {
    const parsed = parseNativeArgs(rc.rawArgs);
    toolCalls.push({
      id: rc.id,
      name: rc.name,
      arguments: parsed.ok ? parsed.value : {},
    });
  }

  // Belt & braces: mine inline JSON calls from the text too
  let content = res.content;
  if (tools.length > 0 && toolCalls.length === 0) {
    const inline = extractInlineToolCalls(content);
    if (inline.calls.length > 0) {
      content = inline.content;
      for (const rc of inline.calls) {
        const parsed = parseNativeArgs(rc.rawArgs);
        toolCalls.push({
          id: rc.id,
          name: rc.name,
          arguments: parsed.ok ? parsed.value : {},
        });
      }
    }
  }

  return { content, toolCalls, raw: res.raw };
}

function toToolkitMessage(m: LLMMessage): ToolkitMessage {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, toolCallId: m.toolCallId ?? "", name: m.name };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return { role: "assistant", content: m.content, toolCalls: m.toolCalls };
  }
  return { role: m.role as "system" | "user" | "assistant", content: m.content };
}

/* ------------------------------------------------------------------ */
/* Test-connection helper (used by admin panel "Test" button)         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* VISION (OCR) — for extracting transactions from images             */
/* ------------------------------------------------------------------ */

export interface VisionImage {
  /** Base64-encoded image bytes (without data: prefix) */
  base64: string;
  /** MIME type, e.g. "image/png", "image/jpeg", "image/webp" */
  mimeType: string;
}

/**
 * Send a vision request — image + text prompt to a multimodal model.
 * Now routed through the SDK transport (timeout + retries).
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
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const content: unknown[] = [{ type: "text", text: textPrompt }];
  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
  }
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: "user", content }],
    temperature: config.temperature,
    [config.maxTokensMode === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"]:
      config.maxTokens || 2000,
  };
  if (options.forceJsonOutput) {
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
    throw new Error(`Vision API ${msg}`);
  }
  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice) throw new Error("Vision API returned no choices");
  return { content: choice.message?.content ?? "", toolCalls: [], raw: json };
}

// --- Anthropic vision ---
async function chatCompleteVisionAnthropic(
  config: AgentConfig,
  images: VisionImage[],
  textPrompt: string
): Promise<LLMResponse> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/messages`;
  const content: unknown[] = [];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.base64 },
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
    throw new Error(`Anthropic vision ${msg}`);
  }
  const json = await res.json();
  const blocks = Array.isArray(json.content) ? json.content : [];
  let text = "";
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
  }
  return { content: text, toolCalls: [], raw: json };
}

/* ------------------------------------------------------------------ */
/* STT                                                                 */
/* ------------------------------------------------------------------ */

export async function testSttConnection(config: AgentConfig): Promise<{ ok: boolean; message: string }> {
  try {
    if (!config.baseUrl) {
      return { ok: false, message: "No base URL set." };
    }
    const sttUrl = resolveSttUrl(config.baseUrl);

    const headers: Record<string, string> = {
      ...parseExtraHeaders(config),
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const res = await fetch(sttUrl, { method: "POST", headers });

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

/**
 * Resolve an STT endpoint URL from whatever the user/admin pasted.
 *
 * Accepts ALL of these and always lands on a correct /audio/transcriptions URL:
 *   https://api.groq.com/openai/v1                                → +/audio/transcriptions
 *   https://api.groq.com/openai/v1/audio/transcriptions           → as-is
 *   https://api.groq.com/openai/v1/chat/completions  (wrong paste)→ fixed to /audio/transcriptions
 *   https://api.groq.com/openai/v1/audio/speech      (TTS paste)  → fixed to /audio/transcriptions
 *   https://whisper.example.com                                   → +/audio/transcriptions
 */
export function resolveSttUrl(raw: string): string {
  let u = (raw ?? "").trim().replace(/\s+/g, "");
  if (!u) return "";
  u = u.replace(/\/+$/, "");
  const lower = u.toLowerCase();

  if (lower.endsWith("/audio/transcriptions")) return u; // already a full endpoint
  if (lower.endsWith("/audio/speech")) u = u.slice(0, -"/audio/speech".length);
  else if (lower.endsWith("/chat/completions")) u = u.slice(0, -"/chat/completions".length);
  else if (lower.endsWith("/transcriptions")) u = u.slice(0, -"/transcriptions".length) + "/audio/transcriptions";

  return `${u}/audio/transcriptions`;
}
