import { NextRequest, NextResponse } from "next/server";
import { verifyAdminCredentials, createAdminSession } from "@/lib/auth/admin";
import { setSessionCookie } from "@/lib/auth/cookies";

const ADMIN_TTL_SECONDS = 2 * 60 * 60; // 2 hours

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }
  const ok = await verifyAdminCredentials(username, password);
  if (!ok) {
    return NextResponse.json({ error: "Invalid admin credentials" }, { status: 401 });
  }
  const session = await createAdminSession();
  await setSessionCookie("admin", session.token, ADMIN_TTL_SECONDS);
  return NextResponse.json({ ok: true });
}
