import { db } from "@/lib/db";

// In-memory cache (short TTL so admin config changes propagate quickly,
// even across separately-bundled route module instances).
const cache = new Map<string, { value: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 30 * 1000;

export async function getAdminConfig<T = unknown>(key: string, fallback?: T): Promise<T> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as T;
  }
  const row = await db.adminConfig.findUnique({ where: { key } });
  if (!row) {
    return (fallback ?? ({} as T)) as T;
  }
  try {
    const parsed = JSON.parse(row.value) as T;
    cache.set(key, { value: parsed, expiresAt: Date.now() + CACHE_TTL_MS });
    return parsed;
  } catch {
    return (fallback ?? ({} as T)) as T;
  }
}

export async function setAdminConfig<T = unknown>(key: string, value: T): Promise<void> {
  const json = JSON.stringify(value);
  await db.adminConfig.upsert({
    where: { key },
    update: { value: json },
    create: { key, value: json },
  });
  cache.delete(key); // invalidate
}

export async function getAllAdminConfig(): Promise<Record<string, unknown>> {
  const rows = await db.adminConfig.findMany();
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export interface AgentConfig {
  provider: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokensMode: "max_tokens" | "max_completion_tokens";
  maxTokens: number;
  toolCallingSupported: boolean;
  systemPrompt: string;
  /** Optional JSON string of extra HTTP headers, e.g. {"HTTP-Referer":"https://myapp.com"} */
  extraHeaders?: string;
}

export interface SttConfig extends AgentConfig {
  engine: "native" | "openai-compatible";
}

export interface OcrConfig extends AgentConfig {
  enabled: boolean;
}

export interface FeatureFlags {
  pdfUpload: boolean;
  ocr: boolean;
  sttNative: boolean;
  webPush: boolean;
  autoAppendTotals: boolean;
  defaultLanguage: "english" | "hinglish" | "hindi";
}

export interface SchemaMode {
  mode: "llm" | "rag";
  lastNTxns: number;
  refreshEveryCall: boolean;
}

export interface GlossaryEntry {
  term: string;
  desc: string;
}

export async function getDailyAgentConfig(): Promise<AgentConfig> {
  return getAdminConfig<AgentConfig>("agent.daily");
}
export async function getDashboardAgentConfig(): Promise<AgentConfig> {
  return getAdminConfig<AgentConfig>("agent.dashboard");
}
export async function getSttConfig(): Promise<SttConfig> {
  return getAdminConfig<SttConfig>("agent.stt");
}
export async function getOcrConfig(): Promise<OcrConfig> {
  return getAdminConfig<OcrConfig>("agent.ocr");
}
export async function getFeatureFlags(): Promise<FeatureFlags> {
  return getAdminConfig<FeatureFlags>("featureFlags");
}
export async function getSchemaMode(): Promise<SchemaMode> {
  return getAdminConfig<SchemaMode>("schemaMode");
}
export async function getGlossary(): Promise<GlossaryEntry[]> {
  return getAdminConfig<GlossaryEntry[]>("glossary", []);
}
export async function getTimeTemplate(): Promise<string> {
  return getAdminConfig<string>("timeTemplate", "");
}
