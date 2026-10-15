import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateGmail, issueOtp } from "@/lib/email";

/**
 * POST /api/auth/resend-otp  { email, purpose: "signup" | "forgot" }
 * Re-sends the OTP (60s cooldown enforced in issueOtp).
 */
export async function POST(req: NextRequest) {
  const { email, purpose } = await req.json().catch(() => ({}));
  const g = validateGmail(email ?? "");
  if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });
  if (purpose !== "signup" && purpose !== "forgot") {
    return NextResponse.json({ error: "Invalid purpose" }, { status: 400 });
  }

  const user = await db.user.findUnique({ where: { email: g.email! } });
  if (!user || (purpose === "forgot" && !user.emailVerified)) {
    // Don't reveal whether the account exists.
    return NextResponse.json({ ok: true });
  }

  const otp = await issueOtp(user.id, user.email, purpose);
  if (!otp.ok) {
    if (otp.retryAfterSec) {
      return NextResponse.json(
        { error: `A code was just sent — try again in ${otp.retryAfterSec}s` },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: otp.error ?? "Could not send the code" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, devCode: otp.devCode });
}
