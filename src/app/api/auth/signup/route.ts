import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/credentials";
import { validateGmail, uniqueUsernameFromEmail, issueOtp } from "@/lib/email";

/**
 * POST /api/auth/signup  { email, password, agreed }
 *
 * Creates an unverified account and emails a 6-digit OTP (Resend).
 * The account becomes usable only after /api/auth/verify-otp.
 */
export async function POST(req: NextRequest) {
  const { email, password, agreed } = await req.json().catch(() => ({}));

  if (agreed !== true) {
    return NextResponse.json(
      { error: "Please agree to the Terms of Service and Privacy Policy first" },
      { status: 400 }
    );
  }

  const g = validateGmail(email ?? "");
  if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });
  const gmail = g.email!;

  if (typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const existing = await db.user.findUnique({ where: { email: gmail } });
  if (existing && existing.emailVerified) {
    return NextResponse.json(
      { error: "An account with this Gmail already exists — sign in instead" },
      { status: 409 }
    );
  }

  let userId: string;
  if (existing) {
    // Unverified signup in progress → restart it with the new password.
    await db.user.update({
      where: { id: existing.id },
      data: { passwordHash: await hashPassword(password) },
    });
    userId = existing.id;
  } else {
    const username = await uniqueUsernameFromEmail(gmail.slice(0, -"@gmail.com".length));
    const user = await db.user.create({
      data: {
        email: gmail,
        username,
        passwordHash: await hashPassword(password),
        emailVerified: false,
        isActive: true,
      },
    });
    userId = user.id;
  }

  const otp = await issueOtp(userId, gmail, "signup");
  if (!otp.ok) {
    if (otp.retryAfterSec) {
      return NextResponse.json(
        { error: `A code was just sent — try again in ${otp.retryAfterSec}s` },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: otp.error ?? "Could not send the code" }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    email: gmail,
    devCode: otp.devCode, // present only in dev mode (no RESEND_API_KEY)
  });
}
