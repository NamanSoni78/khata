import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/credentials";
import { validateGmail, verifyOtp } from "@/lib/email";

/**
 * POST /api/auth/reset-password  { email, code, newPassword }
 * Verifies the "forgot" OTP and sets a new password (all sessions for the
 * user are destroyed so stolen cookies can't outlive a reset).
 */
export async function POST(req: NextRequest) {
  const { email, code, newPassword } = await req.json().catch(() => ({}));
  const g = validateGmail(email ?? "");
  if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const user = await db.user.findUnique({ where: { email: g.email! } });
  if (!user) return NextResponse.json({ error: "Wrong code" }, { status: 400 });

  const v = await verifyOtp(user.id, "forgot", code ?? "");
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  // Kill every session (daily + dashboard) — fresh login required.
  await db.userSession.deleteMany({ where: { userId: user.id } });

  return NextResponse.json({ ok: true });
}
