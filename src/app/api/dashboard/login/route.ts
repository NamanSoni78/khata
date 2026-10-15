import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyMpin, verifyPassword } from "@/lib/auth/credentials";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookies";
import { validateGmail } from "@/lib/email";

const DASHBOARD_TTL_SECONDS = 4 * 60 * 60; // 4 hours hard cap (15-min idle enforced on validate)
const MAX_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000;

/**
 * POST /api/dashboard/login  { email, dashboardMpin }  OR  { email, password }
 *
 * 6-digit dashboard MPIN for returning users; email+password fallback when
 * no dashboard MPIN is set (or after MPIN lockout).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const g = validateGmail(body.email ?? "");
  if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });

  const user = await db.user.findUnique({ where: { email: g.email! } });
  if (!user || !user.isActive || !user.emailVerified) {
    return NextResponse.json({ error: "No account for this Gmail" }, { status: 401 });
  }

  // --- MPIN path (preferred) ---
  if (body.dashboardMpin !== undefined) {
    const row = await db.userMpin.findUnique({ where: { userId: user.id } });
    if (!row?.dashboardMpinHash) {
      return NextResponse.json(
        { error: "No dashboard MPIN set — sign in with your password", needsPassword: true },
        { status: 400 }
      );
    }
    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      const waitMin = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60000);
      return NextResponse.json(
        { error: `MPIN locked — try again in ${waitMin} min, or use your password` },
        { status: 423 }
      );
    }
    const ok = await verifyMpin(String(body.dashboardMpin), row.dashboardMpinHash);
    if (!ok) {
      const fails = row.dashFailedAttempts + 1;
      await db.userMpin.update({
        where: { userId: user.id },
        data: {
          dashFailedAttempts: fails >= MAX_ATTEMPTS ? 0 : fails,
          lockedUntil: fails >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MS) : row.lockedUntil,
        },
      });
      const left = MAX_ATTEMPTS - fails;
      return NextResponse.json(
        { error: left > 0 ? `Wrong MPIN — ${left} ${left === 1 ? "try" : "tries"} left` : "MPIN locked for 10 minutes" },
        { status: 401 }
      );
    }
    if (row.dashFailedAttempts !== 0) {
      await db.userMpin.update({ where: { userId: user.id }, data: { dashFailedAttempts: 0 } });
    }
    const session = await createSession(user.id, "dashboard");
    await setSessionCookie("dashboard", session.token, DASHBOARD_TTL_SECONDS);
    return NextResponse.json({ ok: true, idleTimeoutMs: 15 * 60 * 1000 });
  }

  // --- Password fallback ---
  const pwOk = await verifyPassword(String(body.password ?? ""), user.passwordHash);
  if (!pwOk) return NextResponse.json({ error: "Wrong password" }, { status: 401 });

  const session = await createSession(user.id, "dashboard");
  await setSessionCookie("dashboard", session.token, DASHBOARD_TTL_SECONDS);
  return NextResponse.json({ ok: true, idleTimeoutMs: 15 * 60 * 1000 });
}
