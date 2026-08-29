import { NextRequest, NextResponse } from "next/server";
import { finishLogin } from "@/lib/auth/webauthn";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

const DAILY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export async function POST(req: NextRequest) {
  const { username, assertion } = await req.json();
  if (!assertion) {
    return NextResponse.json({ error: "Missing assertion" }, { status: 400 });
  }
  try {
    const result = await finishLogin(assertion, username, req);
    if (!result.verified) {
      return NextResponse.json({ error: "Verification failed" }, { status: 401 });
    }
    // Check user is still active
    const user = await db.user.findUnique({ where: { id: result.userId } });
    if (!user || !user.isActive) {
      return NextResponse.json({ error: "User disabled" }, { status: 403 });
    }
    const session = await createSession(user.id, "daily");
    await setSessionCookie("daily", session.token, DAILY_TTL_SECONDS);
    return NextResponse.json({
      ok: true,
      username: user.username,
      requiresMpinSetup: false, // already has WebAuthn so MPIN setup is optional
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 400 });
  }
}
