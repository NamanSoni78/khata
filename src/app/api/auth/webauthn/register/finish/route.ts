import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { finishRegistration } from "@/lib/auth/webauthn";

export async function POST(req: NextRequest) {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  const { credential, deviceType } = body as { credential: any; deviceType?: string };
  if (!credential) {
    return NextResponse.json({ error: "Missing credential" }, { status: 400 });
  }
  try {
    const verification = await finishRegistration(user.id, credential, deviceType, req);
    return NextResponse.json({ verified: verification.verified });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 400 });
  }
}
