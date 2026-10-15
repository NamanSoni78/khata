import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import { createReminder, deleteReminder, pauseReminder, describeReminder, repairMissingQStashSchedules } from "@/lib/scheduler";
import { originFromRequest } from "@/lib/app-url";
import { listDevices } from "@/lib/notifications/push";

// GET: list user's reminders (human-readable descriptions — never cron syntax)
export async function GET(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Opportunistic self-healing: re-register QStash exact-time delivery for
  // reminders that lost it (e.g. created while the app URL env lacked a
  // scheme — every schedule create 400'd back then). The request-derived
  // origin (x-forwarded-host/proto) is the healthiest possible destination:
  // it's the host the client JUST reached us on, immune to stale build-time
  // env values. Throttled internally — effectively free on repeated loads.
  repairMissingQStashSchedules(false, originFromRequest(req) ?? undefined).catch(() => {});
  const notifs = await db.scheduledNotification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  // V1.5: the user's subscribed devices (browser + OS + when) — surfaces
  // stale ghost subscriptions that silently swallow pushes.
  const devices = await listDevices(user.id).catch(() => []);
  return NextResponse.json({
    notifications: notifs.map((n) => ({
      id: n.id,
      type: n.type,
      time: n.time,
      date: n.date,
      daysOfWeek: JSON.parse(n.daysOfWeek ?? "[]"),
      dayOfMonth: n.dayOfMonth,
      description: describeReminder(n),
      title: n.title,
      message: n.message,
      isActive: n.isActive,
      nextRunAt: n.nextRunAt?.toISOString() ?? null,
      lastFiredAt: n.lastFiredAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
    devices,
  });
}

// POST: create a reminder — structured calendar-style body:
// { type: 'once'|'daily'|'weekly'|'monthly', time: 'HH:MM', date?, days?, day_of_month?, message, title? }
export async function POST(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const type = String(body.type ?? "");
  const time = String(body.time ?? "");
  const message = String(body.message ?? "");

  if (!["once", "daily", "weekly", "monthly"].includes(type)) {
    return NextResponse.json({ error: "Pick a repeat type" }, { status: 400 });
  }
  if (!/^\d{1,2}:\d{2}$/.test(time)) {
    return NextResponse.json({ error: "Pick a valid time" }, { status: 400 });
  }
  if (!message.trim()) {
    return NextResponse.json({ error: "Add a message" }, { status: 400 });
  }
  if (type === "weekly" && (!Array.isArray(body.days) || body.days.length === 0)) {
    return NextResponse.json({ error: "Pick at least one weekday" }, { status: 400 });
  }
  if (type === "monthly" && !(Number(body.day_of_month) >= 1 && Number(body.day_of_month) <= 31)) {
    return NextResponse.json({ error: "Pick a day of the month (1-31)" }, { status: 400 });
  }
  if (type === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? ""))) {
    return NextResponse.json({ error: "Pick a date" }, { status: 400 });
  }

  try {
    const row = await createReminder(
      user.id,
      {
        type: type as "once" | "daily" | "weekly" | "monthly",
        time,
        date: body.date ? String(body.date) : undefined,
        daysOfWeek: Array.isArray(body.days) ? body.days.map(Number) : undefined,
        dayOfMonth: body.day_of_month ? Number(body.day_of_month) : undefined,
        title: body.title ? String(body.title) : "Khata",
        message: message.trim(),
        timezone: "Asia/Kolkata",
      },
      // Request-derived origin → QStash destination is ALWAYS the real public
      // host, regardless of stale/mangled env vars.
      { baseUrl: originFromRequest(req) ?? undefined }
    );
    // delivery tells the client how this reminder will actually fire:
    //   "exact" — QStash schedule/publish registered (fires at the exact minute)
    //   "poll"  — no QStash; fires when a server instance is warm
    const delivery = row.qstashScheduleId ? "exact" : "poll";
    return NextResponse.json({ ok: true, id: row.id, description: describeReminder(row), delivery });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Couldn't schedule" }, { status: 400 });
  }
}

// PATCH: pause / resume
export async function PATCH(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, isActive } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    await pauseReminder(user.id, String(id), !!isActive, {
      baseUrl: originFromRequest(req) ?? undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Couldn't update" }, { status: 400 });
  }
}

// DELETE (also cancels any QStash schedule)
export async function DELETE(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await deleteReminder(user.id, id);
  return NextResponse.json({ ok: true });
}
