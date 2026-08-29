import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/credentials";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookies";

const DASHBOARD_TTL_SECONDS = 4 * 60 * 60; // 4 hours hard cap

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

  const session = await createSession(user.id, "dashboard");
  await setSessionCookie("dashboard", session.token, DASHBOARD_TTL_SECONDS);
  return NextResponse.json({ ok: true, idleTimeoutMs: 15 * 60 * 1000 });
}
