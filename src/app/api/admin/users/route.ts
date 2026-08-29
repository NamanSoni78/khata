import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/credentials";

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
      username: true,
      isActive: true,
      createdAt: true,
      _count: { select: { accounts: true, transactions: true, chatMessages: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ users });
}

// POST: create a new user
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: "Missing username or password" }, { status: 400 });
  }
  if (username.length < 3) {
    return NextResponse.json({ error: "Username must be at least 3 chars" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 chars" }, { status: 400 });
  }

  const existing = await db.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ error: "Username already exists" }, { status: 409 });
  }

  const hash = await hashPassword(password);
  const user = await db.user.create({
    data: { username, passwordHash: hash },
  });
  return NextResponse.json({ ok: true, userId: user.id, username });
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
