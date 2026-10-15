import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateGmail, issueOtp } from "@/lib/email";

/**
 * POST /api/auth/forgot-password  { email }
 * Sends a password-reset OTP. Always returns ok (no account enumeration);
 * devCode is only present in dev mode when the account exists.
 */
export async function POST(req: NextRequest) {
  const { email } = await req.json().catch(() => ({}));
  const g = validateGmail(email ?? "");
  if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });

  const user = await db.user.findUnique({ where: { email: g.email! } });
  if (!user || !user.emailVerified) {
    return NextResponse.json({ ok: true });
  }

  const otp = await issueOtp(user.id, user.email, "forgot");
  if (!otp.ok && otp.retryAfterSec) {
    return NextResponse.json(
      { error: `A code was just sent — try again in ${otp.retryAfterSec}s` },
      { status: 429 }
    );
  }
  if (!otp.ok) {
    return NextResponse.json({ error: otp.error ?? "Could not send the code" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, devCode: otp.devCode });
}
