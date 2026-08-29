import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { getFeatureFlags } from "@/lib/admin-config";
import { db } from "@/lib/db";

// Returns the current authenticated user + flags
export async function GET() {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ authenticated: false });
  }
  const [mpin, webauthnCreds, flags] = await Promise.all([
    db.userMpin.findUnique({ where: { userId: user.id } }),
    db.userWebAuthnCredential.findMany({
      where: { userId: user.id },
      select: { id: true, deviceType: true, createdAt: true, credentialId: true },
      orderBy: { createdAt: "desc" },
    }),
    getFeatureFlags(),
  ]);
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(user.prefs || "{}"); } catch { prefs = {}; }

  return NextResponse.json({
    authenticated: true,
    username: user.username,
    userId: user.id,
    hasMpin: !!mpin,
    hasWebauthn: webauthnCreds.length > 0,
    passkeys: webauthnCreds.map((c) => ({
      id: c.id,
      deviceType: c.deviceType ?? "Unknown device",
      createdAt: c.createdAt.toISOString(),
      credentialIdShort: c.credentialId.slice(0, 12) + "...",
    })),
    // Per-user UI preferences (wallpaper, voice language, auto fingerprint…)
    prefs,
    // Feature flags (so the UI knows which upload buttons to show)
    flags: {
      pdfUpload: flags.pdfUpload,
      ocr: flags.ocr,
      sttNative: flags.sttNative,
      webPush: flags.webPush,
    },
  });
}

