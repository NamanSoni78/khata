import { NextRequest, NextResponse } from "next/server";
import { beginLogin } from "@/lib/auth/webauthn";

export async function POST(req: NextRequest) {
  const { username } = await req.json().catch(() => ({ username: undefined }));
  try {
    const options = await beginLogin(username, req);
    return NextResponse.json(options);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 400 });
  }
}
