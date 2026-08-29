import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/credentials";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookies";
import { getFeatureFlags } from "@/lib/admin-config";

const DAILY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: "Missing username or password" }, { status: 400 });
  }
  const user = await db.user.findUnique({ where: { username } });
  if (!user || !user.isActive) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  // Check if MPIN is set up
  const mpin = await db.userMpin.findUnique({ where: { userId: user.id } });
  const flags = await getFeatureFlags();

  const session = await createSession(user.id, "daily");
  await setSessionCookie("daily", session.token, DAILY_TTL_SECONDS);

  return NextResponse.json({
    ok: true,
    requiresMpinSetup: !mpin,
    hasWebauthn: (await db.userWebAuthnCredential.count({ where: { userId: user.id } })) > 0,
    defaultLanguage: flags.defaultLanguage,
  });
}
