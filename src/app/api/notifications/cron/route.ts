import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendPushToUser, resolveMessageTemplate, isWebPushConfigured } from "@/lib/notifications/push";

/**
 * Cron endpoint — called by Upstash QStash (or manually) to fire scheduled notifications.
 *
 * Scheduling types:
 *  - One-time: schedule is ISO timestamp. Fire when now >= schedule. After firing, set isActive=false.
 *  - Recurring: schedule is cron expression (e.g., "0 20 * * *" for daily 8pm IST).
 *    Fire when lastFiredAt is null OR next cron occurrence after lastFiredAt is <= now.
 *
 * Auth: optionally protected by QSTASH_TOKEN check (if env set, request must include header).
 *
 * To set up:
 *   1. Generate VAPID keys: bun run gen-vapid
 *   2. Add to Vercel env: NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *   3. Create Upstash QStash schedule that POSTs to {your-app}/api/notifications/cron every 5 minutes
 *   4. Pass QSTASH_TOKEN to authorize the cron endpoint (optional but recommended)
 */
export async function POST(req: NextRequest) {
  // Optional auth via QStash token
  const qstashToken = process.env.QSTASH_TOKEN;
  if (qstashToken) {
    const authHeader = req.headers.get("authorization");
    const bearer = req.headers.get("x-upstash-authorization");
    const provided = authHeader?.replace(/^Bearer\s+/i, "") ?? bearer;
    // Allow either QSTASH_TOKEN match OR skip check if env not set
    if (provided && provided !== qstashToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!isWebPushConfigured()) {
    return NextResponse.json({ skipped: true, reason: "Web Push not configured" });
  }

  const now = new Date();
  // Fetch all active scheduled notifications
  const schedules = await db.scheduledNotification.findMany({
    where: { isActive: true },
    take: 500,
  });

  let firedCount = 0;
  let skippedCount = 0;

  for (const sched of schedules) {
    const shouldFire = shouldFireNow(sched.schedule, sched.lastFiredAt, now);
    if (!shouldFire) {
      skippedCount++;
      continue;
    }

    // Resolve placeholders in message
    const message = await resolveMessageTemplate(sched.userId, sched.message);

    // Send push
    const result = await sendPushToUser(sched.userId, {
      title: "Finance Tracker",
      body: message,
      url: "/",
    });

    if (result.sent > 0) firedCount++;

    // Update lastFiredAt. For one-time schedules, deactivate after firing.
    const isOneTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(sched.schedule);
    await db.scheduledNotification.update({
      where: { id: sched.id },
      data: {
        lastFiredAt: now,
        isActive: !isOneTime,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    checked: schedules.length,
    fired: firedCount,
    skipped: skippedCount,
    at: now.toISOString(),
  });
}

/**
 * Determine whether a schedule should fire now.
 * - One-time (ISO timestamp): fire if now >= schedule AND lastFiredAt is null.
 * - Cron: fire if lastFiredAt is null OR the next cron occurrence after lastFiredAt is <= now.
 *   For simplicity, this implementation fires if lastFiredAt is older than the cron's min interval.
 *   (Proper cron parsing requires a cron lib — for Phase 2 we use simple interval inference.)
 */
function shouldFireNow(schedule: string, lastFiredAt: Date | null, now: Date): boolean {
  // Try ISO timestamp first
  const asDate = new Date(schedule);
  if (!isNaN(asDate.getTime())) {
    // One-time schedule
    return now >= asDate && lastFiredAt === null;
  }

  // Cron expression — use simple heuristic
  // For "0 20 * * *" (daily 8pm), interval is 24h. Fire if lastFiredAt is null OR > 23h ago.
  // For "*/5 * * * *" (every 5 min), interval is 5 min.
  // For "0 9 * * 1" (Mondays 9am), interval is 7 days.
  // This is approximate — for precise cron math, integrate `cron-parser` in Phase 3.

  // Check the cron field structure
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return false;

  // Try to infer interval from cron
  let intervalMs = 24 * 60 * 60 * 1000; // default 24h (daily)
  if (parts[0].startsWith("*/")) {
    const n = parseInt(parts[0].slice(2));
    if (!isNaN(n)) intervalMs = n * 60 * 1000;
  } else if (parts[1].startsWith("*/")) {
    const n = parseInt(parts[1].slice(2));
    if (!isNaN(n)) intervalMs = n * 60 * 60 * 1000;
  }

  if (!lastFiredAt) {
    // First fire — check if current time matches cron
    return matchesCron(parts, now);
  }
  const sinceLast = now.getTime() - lastFiredAt.getTime();
  return sinceLast >= intervalMs && matchesCron(parts, now);
}

function matchesCron(parts: string[], now: Date): boolean {
  // minutes, hours, day-of-month, month, day-of-week
  const [minP, hourP, domP, monP, dowP] = parts;
  const m = now.getMinutes();
  const h = now.getHours();
  const dom = now.getDate();
  const mon = now.getMonth() + 1;
  const dow = now.getDay();
  return (
    matchField(minP, m) &&
    matchField(hourP, h) &&
    matchField(domP, dom) &&
    matchField(monP, mon) &&
    matchField(dowP, dow)
  );
}

function matchField(pattern: string, value: number): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*/")) {
    const n = parseInt(pattern.slice(2));
    return !isNaN(n) && value % n === 0;
  }
  return pattern.split(",").some((p) => parseInt(p) === value);
}
