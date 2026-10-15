import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth/cookies";

export async function POST() {
  await clearSessionCookie("admin");
  return NextResponse.json({ ok: true });
}
