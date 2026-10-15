/**
 * Per-user AI configuration ("bring your own key").
 *
 * Users can override the admin defaults for each service from the dashboard
 * settings: their own OpenAI-compatible base URL + API key + model for
 *  - the home chat LLM        (key: "ai.daily")
 *  - the dashboard agent LLM  (key: "ai.dashboard")
 *  - speech-to-text           (key: "ai.stt")
 *  - vision / OCR             (key: "ai.vision")
 * plus custom instructions    (key: "ai.instructions") appended to their
 * system prompts.
 *
 * Resolution is a field-by-field merge — the admin config is the base and any
 * non-empty user field overrides it. A user who only sets a model rides on
 * the admin's gateway; a user who sets URL+key+model is fully independent.
 */
import { db } from "@/lib/db";
import {
  getDailyAgentConfig,
  getDashboardAgentConfig,
  getSttConfig,
  getOcrConfig,
  getFeatureFlags,
  type AgentConfig,
  type SttConfig,
  type OcrConfig,
} from "@/lib/admin-config";

export interface AiConfigPatch {
  provider?: "openai-compatible" | "anthropic";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokensMode?: "max_tokens" | "max_completion_tokens";
  maxTokens?: number;
  toolCallingSupported?: boolean;
  extraHeaders?: string;
  engine?: "native" | "openai-compatible";
}

export interface UserInstructions {
  daily?: string;
  dashboard?: string;
}

const CACHE_TTL_MS = 15 * 1000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();

async function getUserConfig<T>(userId: string, key: string): Promise<T | null> {
  const ck = `${userId}:${key}`;
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const row = await db.userConfig.findUnique({
    where: { userId_key: { userId, key } },
  });
  let value: T | null = null;
  if (row) {
    try { value = JSON.parse(row.value) as T; } catch { value = null; }
  }
  cache.set(ck, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function setUserConfig(userId: string, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value ?? {});
  await db.userConfig.upsert({
    where: { userId_key: { userId, key } },
    update: { value: json },
    create: { userId, key, value: json },
  });
  cache.delete(`${userId}:${key}`);
}

export async function deleteUserConfig(userId: string, key: string): Promise<void> {
  await db.userConfig.deleteMany({ where: { userId, key } });
  cache.delete(`${userId}:${key}`);
}

/** All of a user's AI overrides at once (settings page). */
export async function getAllUserAiConfig(userId: string) {
  const [daily, dashboard, stt, vision, instructions] = await Promise.all([
    getUserConfig<AiConfigPatch>(userId, "ai.daily"),
    getUserConfig<AiConfigPatch>(userId, "ai.dashboard"),
    getUserConfig<AiConfigPatch>(userId, "ai.stt"),
    getUserConfig<AiConfigPatch>(userId, "ai.vision"),
    getUserConfig<UserInstructions>(userId, "ai.instructions"),
  ]);
  // API keys are secrets — mask them for the UI (edit = type a new one).
  return {
    daily: maskPatch(daily),
    dashboard: maskPatch(dashboard),
    stt: maskPatch(stt),
    vision: maskPatch(vision),
    instructions: instructions ?? {},
  };
}

function maskPatch(p: AiConfigPatch | null): AiConfigPatch | null {
  if (!p) return null;
  return { ...p, apiKey: p.apiKey ? "••••••••" : "" };
}

/** Field-by-field merge: user patch over admin base (empty strings ignored). */
function mergeAgentConfig(base: AgentConfig, patch: AiConfigPatch | null): AgentConfig {
  if (!patch) return base;
  const merged: AgentConfig = { ...base };
  const str = (v: unknown, cur: string) => (typeof v === "string" && v.trim() ? v.trim() : cur);
  merged.provider = patch.provider ?? merged.provider;
  merged.baseUrl = str(patch.baseUrl, merged.baseUrl);
  merged.apiKey = str(patch.apiKey, merged.apiKey);
  merged.model = str(patch.model, merged.model);
  if (typeof patch.temperature === "number" && !Number.isNaN(patch.temperature)) {
    merged.temperature = Math.max(0, Math.min(2, patch.temperature));
  }
  if (typeof patch.maxTokens === "number" && patch.maxTokens > 0) {
    merged.maxTokens = Math.min(patch.maxTokens, 200000);
  }
  if (patch.maxTokensMode) merged.maxTokensMode = patch.maxTokensMode;
  if (typeof patch.toolCallingSupported === "boolean") {
    merged.toolCallingSupported = patch.toolCallingSupported;
  }
  if (typeof patch.extraHeaders === "string" && patch.extraHeaders.trim()) {
    merged.extraHeaders = patch.extraHeaders.trim();
  }
  return merged;
}

/** Effective daily-chat agent config for a user. */
export async function resolveDailyAgentConfig(userId: string): Promise<AgentConfig> {
  const [base, patch] = await Promise.all([
    getDailyAgentConfig(),
    getUserConfig<AiConfigPatch>(userId, "ai.daily"),
  ]);
  return mergeAgentConfig(base, patch);
}

/** Effective dashboard agent config for a user. */
export async function resolveDashboardAgentConfig(userId: string): Promise<AgentConfig> {
  const [base, patch] = await Promise.all([
    getDashboardAgentConfig(),
    getUserConfig<AiConfigPatch>(userId, "ai.dashboard"),
  ]);
  return mergeAgentConfig(base, patch);
}

/** Effective vision/OCR config for a user. */
export async function resolveOcrAgentConfig(userId: string): Promise<OcrConfig> {
  const [base, patch] = await Promise.all([
    getOcrConfig(),
    getUserConfig<AiConfigPatch>(userId, "ai.vision"),
  ]);
  return { ...mergeAgentConfig(base, patch), enabled: base.enabled };
}

export interface EffectiveSttConfig {
  engine: "native" | "openai-compatible";
  /** Resolved server-side only — the client asks /api/stt/transcribe instead. */
  config: SttConfig;
}

/** Effective STT config for a user (engine + provider details). */
export async function resolveSttConfig(userId: string): Promise<EffectiveSttConfig> {
  const [base, patch] = await Promise.all([
    getSttConfig(),
    getUserConfig<AiConfigPatch>(userId, "ai.stt"),
  ]);
  let engine = base.engine;
  const merged = { ...base };
  if (patch) {
    if (patch.engine === "native" || patch.engine === "openai-compatible") engine = patch.engine;
    if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) merged.baseUrl = patch.baseUrl.trim();
    if (typeof patch.apiKey === "string" && patch.apiKey.trim()) merged.apiKey = patch.apiKey.trim();
    if (typeof patch.model === "string" && patch.model.trim()) merged.model = patch.model.trim();
  }
  merged.engine = engine;
  return { engine, config: merged };
}

/** Just the engine — the client uses this to pick its mic implementation. */
export async function getEffectiveSttEngine(userId: string): Promise<"native" | "openai-compatible"> {
  const { engine } = await resolveSttConfig(userId);
  return engine;
}

/** Per-agent custom instructions (appended to the system prompt). */
export async function getUserInstructions(userId: string): Promise<UserInstructions> {
  const ins = await getUserConfig<UserInstructions>(userId, "ai.instructions");
  return ins ?? {};
}

export { getFeatureFlags };
