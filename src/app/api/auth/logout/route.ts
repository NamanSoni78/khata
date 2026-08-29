import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth/cookies";

export async function POST() {
  await clearSessionCookie("daily");
  return NextResponse.json({ ok: true });
}
