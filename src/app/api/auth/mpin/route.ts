import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { hashMpin, verifyMpin } from "@/lib/auth/credentials";
import { DEFAULT_CATEGORIES } from "@/lib/agent/default-categories";

// Helper: get authenticated user
async function getUser() {
  const token = await getSessionToken("daily");
  return await getSessionUser(token, "daily");
}

// POST /api/auth/mpin?action=setup|verify
export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.id === "admin") return NextResponse.json({ error: "Admin has no MPIN" }, { status: 400 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const { mpin } = await req.json();
  if (!mpin || !/^\d{4,6}$/.test(mpin)) {
    return NextResponse.json({ error: "MPIN must be 4-6 digits" }, { status: 400 });
  }

  if (action === "setup") {
    // First-time setup
    const existing = await db.userMpin.findUnique({ where: { userId: user.id } });
    if (existing) {
      return NextResponse.json({ error: "MPIN already set; use action=verify or reset" }, { status: 400 });
    }
    const hash = await hashMpin(mpin);
    await db.userMpin.create({ data: { userId: user.id, mpinHash: hash } });

    // Also seed default categories on first MPIN setup (so the user has sensible defaults)
    const existingCats = await db.category.count({ where: { userId: user.id } });
    if (existingCats === 0) {
      await db.category.createMany({
        data: DEFAULT_CATEGORIES.map((c) => ({
          userId: user.id,
          name: c.name,
          type: c.type,
        })),
      });
    }
    return NextResponse.json({ ok: true, message: "MPIN set + default categories seeded" });
  }

  if (action === "verify") {
    const row = await db.userMpin.findUnique({ where: { userId: user.id } });
    if (!row) return NextResponse.json({ error: "MPIN not set up; use action=setup" }, { status: 400 });
    const ok = await verifyMpin(mpin, row.mpinHash);
    if (!ok) return NextResponse.json({ error: "Invalid MPIN" }, { status: 401 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
