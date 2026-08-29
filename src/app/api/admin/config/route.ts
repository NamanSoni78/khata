import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { getAllAdminConfig, setAdminConfig } from "@/lib/admin-config";

// Ensure caller is admin
async function requireAdmin() {
  const token = await getSessionToken("admin");
  const user = await getSessionUser(token, "admin");
  if (!user) return null;
  return user;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const all = await getAllAdminConfig();
  return NextResponse.json(all);
}

export async function PUT(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  const { key, value } = body as { key: string; value: unknown };
  if (!key || value === undefined) {
    return NextResponse.json({ error: "Missing key or value" }, { status: 400 });
  }
  await setAdminConfig(key, value);
  return NextResponse.json({ ok: true });
}
