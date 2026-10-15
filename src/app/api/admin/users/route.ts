import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

async function requireAdmin() {
  const token = await getSessionToken("admin");
  const user = await getSessionUser(token, "admin");
  if (!user) return null;
  return user;
}

// GET: list all users
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const users = await db.user.findMany({
    where: { id: { not: "admin" } }, // exclude the admin pseudo-user
    select: {
      id: true,
      email: true,
      username: true,
      emailVerified: true,
      isActive: true,
      createdAt: true,
      _count: { select: { accounts: true, transactions: true, chatMessages: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ users });
}

// PATCH: enable/disable a user
export async function PATCH(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { userId, isActive } = await req.json();
  if (!userId || isActive === undefined) {
    return NextResponse.json({ error: "Missing userId or isActive" }, { status: 400 });
  }
  await db.user.update({ where: { id: userId }, data: { isActive } });
  return NextResponse.json({ ok: true });
}
