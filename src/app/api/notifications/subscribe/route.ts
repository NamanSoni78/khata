import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import { isWebPushConfigured } from "@/lib/notifications/push";

export async function POST(req: NextRequest) {
  if (!isWebPushConfigured()) {
    return NextResponse.json({ error: "Web Push not configured (admin must set VAPID env vars)" }, { status: 503 });
  }
  // EITHER session: devices get subscribed from the daily app's settings
  // sheet AND from the dashboard's reminders tab (both ask for permission
  // the moment the user sets any notification).
  let user = await getSessionUser(await getSessionToken("daily"), "daily");
  if (!user || user.id === "admin") {
    user = await getSessionUser(await getSessionToken("dashboard"), "dashboard");
  }
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { endpoint, keys } = await req.json();
  if (!endpoint || !keys) {
    return NextResponse.json({ error: "Missing endpoint or keys" }, { status: 400 });
  }
  // Idempotent: if subscription already exists for this endpoint, return it
  const existing = await db.pushSubscription.findFirst({ where: { userId: user.id, endpoint } });
  if (existing) return NextResponse.json({ ok: true, id: existing.id });
  const sub = await db.pushSubscription.create({
    data: { userId: user.id, endpoint, keys: JSON.stringify(keys) },
  });
  return NextResponse.json({ ok: true, id: sub.id });
}

export async function DELETE(req: NextRequest) {
  if (!isWebPushConfigured()) {
    return NextResponse.json({ error: "Web Push not configured" }, { status: 503 });
  }
  let user = await getSessionUser(await getSessionToken("daily"), "daily");
  if (!user || user.id === "admin") {
    user = await getSessionUser(await getSessionToken("dashboard"), "dashboard");
  }
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { endpoint } = await req.json();
  if (!endpoint) return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
  await db.pushSubscription.deleteMany({ where: { userId: user.id, endpoint } });
  return NextResponse.json({ ok: true });
}
