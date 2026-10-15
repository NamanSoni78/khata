import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateGmail, verifyOtp } from "@/lib/email";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookies";

const DAILY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * POST /api/auth/verify-otp  { email, code }
 *
 * Completes signup: marks the email verified and signs the user in
 * (daily session). The client then runs MPIN setup.
 */
export async function POST(req: NextRequest) {
  const { email, code } = await req.json().catch(() => ({}));
  const g = validateGmail(email ?? "");
  if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });

  const user = await db.user.findUnique({ where: { email: g.email! } });
  if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const v = await verifyOtp(user.id, "signup", code ?? "");
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  if (!user.emailVerified) {
    await db.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  }

  const mpin = await db.userMpin.findUnique({ where: { userId: user.id } });
  const session = await createSession(user.id, "daily");
  await setSessionCookie("daily", session.token, DAILY_TTL_SECONDS);

  return NextResponse.json({
    ok: true,
    username: user.username,
    requiresMpinSetup: !mpin?.appMpinHash,
  });
}
