import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { credentialId } = await req.json();
  if (!credentialId) {
    return NextResponse.json({ error: "Missing credentialId" }, { status: 400 });
  }
  // Verify the credential belongs to this user
  const cred = await db.userWebAuthnCredential.findFirst({
    where: { id: credentialId, userId: user.id },
  });
  if (!cred) {
    return NextResponse.json({ error: "Passkey not found" }, { status: 404 });
  }
  await db.userWebAuthnCredential.delete({ where: { id: cred.id } });
  return NextResponse.json({ ok: true });
}
