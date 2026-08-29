import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

// GET: list user's scheduled notifications
export async function GET() {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const notifs = await db.scheduledNotification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    notifications: notifs.map((n) => ({
      id: n.id,
      schedule: n.schedule,
      message: n.message,
      isActive: n.isActive,
      lastFiredAt: n.lastFiredAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
  });
}

// POST: create a new scheduled notification
export async function POST(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { schedule, message } = await req.json();
  if (!schedule || !message) {
    return NextResponse.json({ error: "Missing schedule or message" }, { status: 400 });
  }
  const notif = await db.scheduledNotification.create({
    data: { userId: user.id, schedule, message, isActive: true },
  });
  return NextResponse.json({ ok: true, id: notif.id });
}

// PATCH: toggle active / delete (set isActive=false)
export async function PATCH(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, isActive } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.scheduledNotification.update({
    where: { id, userId: user.id },
    data: { isActive },
  });
  return NextResponse.json({ ok: true });
}

// DELETE
export async function DELETE(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.scheduledNotification.delete({
    where: { id, userId: user.id },
  }).catch(() => {});
  return NextResponse.json({ ok: true });
}
