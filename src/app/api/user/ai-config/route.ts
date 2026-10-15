import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import {
  getAllUserAiConfig,
  setUserConfig,
  deleteUserConfig,
  type AiConfigPatch,
  type UserInstructions,
} from "@/lib/user-config";
import { testAgentConnection, testSttConnection } from "@/lib/llm/client";
import type { AgentConfig } from "@/lib/admin-config";

async function getUser() {
  const token = await getSessionToken("dashboard");
  return await getSessionUser(token, "dashboard");
}

const CONFIG_KEYS = ["ai.daily", "ai.dashboard", "ai.stt", "ai.vision", "ai.instructions"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];
const MASK = "••••••••";

/**
 * GET /api/user/ai-config — the user's AI overrides (API keys masked).
 */
export async function GET() {
  const user = await getUser();
  if (!user || user.id === "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const all = await getAllUserAiConfig(user.id);
  return NextResponse.json(all);
}

/**
 * PUT /api/user/ai-config  { key, value }
 * Saves an override patch. Semantics per field:
 *   - "" (empty)  → clear this override (fall back to admin default)
 *   - MASK value  → keep the previously saved secret (UI masks keys)
 *   - anything else → set
 */
export async function PUT(req: NextRequest) {
  const user = await getUser();
  if (!user || user.id === "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { key, value } = await req.json().catch(() => ({}));
  if (!CONFIG_KEYS.includes(key)) return NextResponse.json({ error: "Invalid key" }, { status: 400 });

  if (key === "ai.instructions") {
    const ins: UserInstructions = {};
    if (typeof value?.daily === "string") ins.daily = value.daily.slice(0, 4000);
    if (typeof value?.dashboard === "string") ins.dashboard = value.dashboard.slice(0, 4000);
    const hasAny = !!(ins.daily?.trim() || ins.dashboard?.trim());
    if (hasAny) await setUserConfig(user.id, key, ins);
    else await deleteUserConfig(user.id, key);
    return NextResponse.json({ ok: true });
  }

  const patch: AiConfigPatch = {};
  const incoming = value ?? {};

  const takeStr = (field: keyof AiConfigPatch) => {
    const v = incoming[field];
    if (typeof v !== "string") return;
    if (v === MASK) {
      // Preserve existing secret — caller must supply current value separately
      // via `__keep_<field>` semantics handled below.
      (patch as Record<string, unknown>)[field] = MASK_KEEP;
    } else if (v.trim() === "") {
      // explicit clear → omit
    } else {
      (patch as Record<string, unknown>)[field] = v.trim();
    }
  };

  const MASK_KEEP = "__keep__";

  if (typeof incoming.engine === "string" && (incoming.engine === "native" || incoming.engine === "openai-compatible")) {
    patch.engine = incoming.engine;
  }
  if (typeof incoming.provider === "string" && (incoming.provider === "openai-compatible" || incoming.provider === "anthropic")) {
    patch.provider = incoming.provider;
  }
  takeStr("baseUrl");
  takeStr("apiKey");
  takeStr("model");
  takeStr("extraHeaders");
  if (typeof incoming.temperature === "number" && !Number.isNaN(incoming.temperature)) {
    patch.temperature = Math.max(0, Math.min(2, incoming.temperature));
  }
  if (typeof incoming.maxTokens === "number" && incoming.maxTokens > 0) {
    patch.maxTokens = Math.min(incoming.maxTokens, 200000);
  }
  if (incoming.maxTokensMode === "max_tokens" || incoming.maxTokensMode === "max_completion_tokens") {
    patch.maxTokensMode = incoming.maxTokensMode;
  }
  if (typeof incoming.toolCallingSupported === "boolean") {
    patch.toolCallingSupported = incoming.toolCallingSupported;
  }

  // Resolve MASK_KEEP markers against the previously stored patch.
  const { db } = await import("@/lib/db");
  const prevRow = await db.userConfig.findUnique({ where: { userId_key: { userId: user.id, key } } });
  let prev: Record<string, unknown> = {};
  try { prev = prevRow ? JSON.parse(prevRow.value) : {}; } catch { prev = {}; }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === MASK_KEEP) {
      if (typeof prev[k] === "string" && prev[k]) (patch as Record<string, unknown>)[k] = prev[k];
      else delete (patch as Record<string, unknown>)[k];
    }
  }

  const hasAny = Object.keys(patch).length > 0;
  if (hasAny) await setUserConfig(user.id, key, patch);
  else await deleteUserConfig(user.id, key);
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/user/ai-config?key=ai.daily — reset one service to admin defaults.
 */
export async function DELETE(req: NextRequest) {
  const user = await getUser();
  if (!user || user.id === "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const key = new URL(req.url).searchParams.get("key") as ConfigKey | null;
  if (!key || !CONFIG_KEYS.includes(key)) return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  await deleteUserConfig(user.id, key);
  return NextResponse.json({ ok: true });
}

/**
 * POST /api/user/ai-config  { key, config } — test the user's own endpoint.
 * Tests against the FULL effective config (their patch merged onto admin base),
 * so a model-only override is tested through the admin gateway.
 */
export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user || user.id === "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { key, config } = await req.json().catch(() => ({}));
  if (!CONFIG_KEYS.includes(key)) return NextResponse.json({ error: "Invalid key" }, { status: 400 });

  // Build effective config: resolve admin base + user patch
  const {
    resolveDailyAgentConfig,
    resolveDashboardAgentConfig,
    resolveSttConfig,
    resolveOcrAgentConfig,
  } = await import("@/lib/user-config");

  let effective: AgentConfig;
  if (key === "ai.daily") effective = await resolveDailyAgentConfig(user.id);
  else if (key === "ai.dashboard") effective = await resolveDashboardAgentConfig(user.id);
  else if (key === "ai.vision") effective = await resolveOcrAgentConfig(user.id);
  else if (key === "ai.stt") {
    const { config: stt } = await resolveSttConfig(user.id);
    effective = stt;
  } else {
    return NextResponse.json({ error: "Nothing to test for this key" }, { status: 400 });
  }

  // If the client sent a fresh apiKey (un-masked), test with it.
  if (config?.apiKey && typeof config.apiKey === "string" && config.apiKey !== MASK) {
    effective = { ...effective, apiKey: config.apiKey };
  }

  if (key === "ai.stt") {
    const result = await testSttConnection(effective);
    return NextResponse.json(result);
  }
  if (!effective.apiKey) {
    return NextResponse.json({ ok: false, message: "No API key set — enter one before testing." });
  }
  const result = await testAgentConnection(effective);
  return NextResponse.json(result);
}
