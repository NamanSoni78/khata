import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { getFeatureFlags, getEffectiveSttEngine } from "@/lib/user-config";
import { db } from "@/lib/db";

// Returns the current authenticated user + flags + effective AI settings info.
export async function GET() {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ authenticated: false });
  }
  const [mpin, flags, sttEngine, hasUserAi] = await Promise.all([
    db.userMpin.findUnique({ where: { userId: user.id } }),
    getFeatureFlags(),
    getEffectiveSttEngine(user.id),
    db.userConfig.count({ where: { userId: user.id, key: { startsWith: "ai." } } }),
  ]);
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(user.prefs || "{}"); } catch { prefs = {}; }

  return NextResponse.json({
    authenticated: true,
    username: user.username,
    email: user.email,
    userId: user.id,
    hasAppMpin: !!mpin?.appMpinHash,
    hasDashboardMpin: !!mpin?.dashboardMpinHash,
    prefs,
    // Which mic engine this user's client should use: "native" or "openai-compatible"
    sttEngine,
    // Whether the user has configured their own AI keys (settings UI hint)
    hasUserAi: hasUserAi > 0,
    // Feature flags (upload buttons etc.)
    flags: {
      pdfUpload: flags.pdfUpload,
      ocr: flags.ocr,
      webPush: flags.webPush,
    },
  });
}
