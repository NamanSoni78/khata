import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/credentials";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookies";
import { validateGmail } from "@/lib/email";

const DAILY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Naive in-memory brute-force guard (per serverless instance). Long-term
// lockout is handled by the OTP flows + bcrypt cost; this blunts hammering.
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 10 * 60 * 1000;

/**
 * POST /api/auth/login  { email, password }
 * Full login (first device / after logout / after session expiry).
 * Returns whether MPIN setup is still pending.
 */
export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}));
  const g = validateGmail(email ?? "");
  if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });

  const key = g.email!;
  const rec = attempts.get(key);
  if (rec && rec.until > Date.now()) {
    const waitMin = Math.ceil((rec.until - Date.now()) / 60000);
    return NextResponse.json(
      { error: `Too many attempts — try again in ${waitMin} minute${waitMin > 1 ? "s" : ""}` },
      { status: 429 }
    );
  }

  const user = await db.user.findUnique({ where: { email: key } });
  const ok = user && user.isActive && user.emailVerified && (await verifyPassword(password ?? "", user.passwordHash));
  if (!user || !ok) {
    const cur = attempts.get(key) ?? { count: 0, until: 0 };
    cur.count += 1;
    if (cur.count >= MAX_ATTEMPTS) {
      cur.until = Date.now() + LOCK_MS;
      cur.count = 0;
    }
    attempts.set(key, cur);
    return NextResponse.json({ error: "Wrong Gmail or password" }, { status: 401 });
  }

  attempts.delete(key);

  const mpin = await db.userMpin.findUnique({ where: { userId: user.id } });
  const session = await createSession(user.id, "daily");
  await setSessionCookie("daily", session.token, DAILY_TTL_SECONDS);

  return NextResponse.json({
    ok: true,
    username: user.username,
    email: user.email,
    requiresMpinSetup: !mpin?.appMpinHash,
  });
}
