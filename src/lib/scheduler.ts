/**
 * Structured reminder scheduling + Upstash QStash integration.
 *
 * Design (Vercel-free-tier friendly — no Vercel cron needed):
 *
 * 1. REMINDER MODEL — calendar-style (no cron strings anywhere in the UI):
 *      type: 'once' | 'daily' | 'weekly' | 'monthly'
 *      time: 'HH:MM' (24h, IST), date (once), daysOfWeek (weekly), dayOfMonth (monthly)
 *      nextRunAt: precomputed UTC Date
 *
 * 2. EXACT-TIME DELIVERY — when QSTASH_TOKEN is set, each reminder gets its own
 *    QStash schedule (UTC-converted cron) that hits
 *    /api/notifications/cron?rid=<id> at the exact minute. On Vercel free this
 *    is the only reliable external trigger.
 *
 * 3. CATCH-ALL POLL — one QStash cron (every 5 min, set up once in Upstash
 *    dashboard) hits /api/notifications/cron without rid; the endpoint fires
 *    any reminder whose nextRunAt is due (missed exact fires, legacy rows,
 *    deployments without QSTASH_TOKEN). Belt AND suspenders.
 *
 * Timezone math: India is UTC+5:30 year-round (no DST), so IST<->UTC conversion
 * is a deterministic ±5:30 shift. All Date objects are UTC under the hood.
 */
import { db } from "@/lib/db";
import {
  pickAccountForNewSchedule,
  pickAccountForPublish,
  accountForIndex,
  primaryAccount,
} from "@/lib/qstash-pool";

const IST_OFFSET_MIN = 5 * 60 + 30; // IST = UTC + 5:30

export type ReminderType = "once" | "daily" | "weekly" | "monthly";

export interface ReminderInput {
  type: ReminderType;
  /** "HH:MM" 24-hour, IST */
  time: string;
  /** "YYYY-MM-DD" — required for type=once */
  date?: string;
  /** 0-6 (0=Sunday) — required for type=weekly */
  daysOfWeek?: number[];
  /** 1-31 — required for type=monthly */
  dayOfMonth?: number;
  title?: string;
  message: string;
  timezone?: string;
}

// ============================================================
//  IST helpers
// ============================================================

/** Get the current IST calendar parts. */
export function nowIST(): { y: number; m: number; d: number; hh: number; mm: number; weekday: number } {
  const now = new Date();
  const utcMs = now.getTime();
  const istMs = utcMs + IST_OFFSET_MIN * 60 * 1000;
  const ist = new Date(istMs); // read via UTC getters below
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth() + 1,
    d: ist.getUTCDate(),
    hh: ist.getUTCHours(),
    mm: ist.getUTCMinutes(),
    weekday: ist.getUTCDay(),
  };
}

/** Convert IST calendar parts to a UTC Date (IST = UTC + 5:30). */
export function istToUTC(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - IST_OFFSET_MIN * 60 * 1000);
}

function parseHHMM(t: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? "").trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ============================================================
//  nextRunAt computation (IST-aware)
// ============================================================

/** Loose reminder shape accepted by the compute helpers (DB rows and API input). */
export interface ReminderShape {
  type: string;
  time: string;
  date?: string | null;
  daysOfWeek?: string | number[] | null;
  dayOfMonth?: number | null;
}

function parseDays(v: string | number[] | null | undefined): number[] {
  if (Array.isArray(v)) return v.map((d) => ((Number(d) % 7) + 7) % 7);
  try {
    const arr = JSON.parse(v ?? "[]");
    return Array.isArray(arr) ? arr.map((d: unknown) => ((Number(d) % 7) + 7) % 7) : [];
  } catch {
    return [];
  }
}

/** Compute the next UTC run time >= now for a reminder, in IST terms. */
export function computeNextRun(rem: ReminderShape): Date | null {
  const t = parseHHMM(rem.time);
  if (!t) return null;
  const { hh, mm } = t;
  const now = nowIST();

  const at = (y: number, m: number, d: number): Date =>
    new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - IST_OFFSET_MIN * 60 * 1000);

  if (rem.type === "once") {
    if (!rem.date) return null;
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rem.date);
    if (!dm) return null;
    return at(+dm[1], +dm[2], +dm[3]);
  }

  if (rem.type === "daily") {
    // Today at hh:mm if still in the future, else tomorrow.
    let candidate = at(now.y, now.m, now.d);
    if (candidate.getTime() <= Date.now()) {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tm = tomorrow.getTime() + IST_OFFSET_MIN * 60 * 1000;
      const t2 = new Date(tm);
      candidate = at(t2.getUTCFullYear(), t2.getUTCMonth() + 1, t2.getUTCDate());
    }
    return candidate;
  }

  if (rem.type === "weekly") {
    const days = parseDays(rem.daysOfWeek);
    if (days.length === 0) days.push(now.weekday);
    const set = new Set(days);
    // Scan forward up to 7 days for the next matching weekday at hh:mm.
    for (let add = 0; add <= 7; add++) {
      const probeMs = Date.now() + add * 24 * 60 * 60 * 1000;
      const probe = new Date(probeMs + IST_OFFSET_MIN * 60 * 1000);
      const y = probe.getUTCFullYear();
      const mo = probe.getUTCMonth() + 1;
      const dd = probe.getUTCDate();
      const wd = probe.getUTCDay();
      if (!set.has(wd)) continue;
      const candidate = at(y, mo, dd);
      if (candidate.getTime() > Date.now()) return candidate;
    }
    return null;
  }

  if (rem.type === "monthly") {
    const dom = rem.dayOfMonth && rem.dayOfMonth >= 1 && rem.dayOfMonth <= 31 ? rem.dayOfMonth : 1;
    // This month (clamped to month length), else next month.
    const thisMonthDay = Math.min(dom, daysInMonth(now.y, now.m));
    let candidate = at(now.y, now.m, thisMonthDay);
    if (candidate.getTime() > Date.now()) return candidate;
    const nextY = now.m === 12 ? now.y + 1 : now.y;
    const nextM = now.m === 12 ? 1 : now.m + 1;
    const nextDay = Math.min(dom, daysInMonth(nextY, nextM));
    return at(nextY, nextM, nextDay);
  }

  return null;
}

// ============================================================
//  IST "HH:MM" -> UTC cron fields ("M H ..." in UTC)
// ============================================================

/** Convert an IST HH:MM + pattern to a UTC cron expression for QStash. */
export function istReminderToUTCCron(rem: ReminderShape): string | null {
  const t = parseHHMM(rem.time);
  if (!t) return null;
  // UTC minute/hour = IST - 5:30 (borrow across hour/day as needed).
  let utcMin = t.mm - 30;
  let utcHour = t.hh - 5;
  if (utcMin < 0) { utcMin += 60; utcHour -= 1; }
  if (utcHour < 0) utcHour += 24;
  // If the time crossed midnight backwards, the UTC day-of-week is "yesterday"
  // relative to IST — handled below by shifting the weekday list.
  const crossedDayBack = t.hh < 5 || (t.hh === 5 && t.mm < 30);

  const minF = String(utcMin);
  const hourF = String(utcHour);

  if (rem.type === "daily") {
    return `${minF} ${hourF} * * *`;
  }
  if (rem.type === "weekly") {
    const days = parseDays(rem.daysOfWeek);
    if (days.length === 0) return null;
    const shifted = Array.from(new Set(days))
      .map((d) => (crossedDayBack ? (d + 6) % 7 : d)) // shift one day back
      .sort((a, b) => a - b);
    const dowF = shifted.join(",");
    return `${minF} ${hourF} * * ${dowF}`;
  }
  if (rem.type === "monthly") {
    let dom = rem.dayOfMonth ?? 1;
    dom = Math.max(1, Math.min(31, dom));
    // Day shift when crossing midnight backwards
    if (crossedDayBack) dom = dom > 1 ? dom - 1 : 31; // approximate; poll fallback catches edge cases
    return `${minF} ${hourF} ${dom} * *`;
  }
  // once — not a cron; use a delayed publish instead (handled by caller)
  return null;
}

// ============================================================
//  QStash REST client (no SDK dependency — plain fetch)
//  Multi-account: schedules spread across pooled accounts (qstash-pool.ts),
//  one-time publishes rotate round-robin.
// ============================================================

const QSTASH_BASE = "https://qstash.upstash.io/v2";

export function isQStashConfigured(): boolean {
  return !!process.env.QSTASH_TOKEN;
}

/** Absolute cron URL for a reminder (works on any host, incl. khata.namansoni.in). */
function cronUrl(reminderId: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000");
  return `${base.replace(/\/$/, "")}/api/notifications/cron?rid=${reminderId}`;
}

/**
 * Create a QStash schedule for a recurring reminder (exact-minute delivery)
 * on the least-loaded pooled account.
 * Returns { scheduleId, accountIndex }, or null when QStash isn't
 * configured / not applicable.
 */
export async function createQStashScheduleForReminder(reminder: {
  id: string;
  type: string;
  time: string;
  daysOfWeek?: string | null;
  dayOfMonth?: number | null;
}): Promise<{ scheduleId: string; accountIndex: number } | null> {
  if (!isQStashConfigured()) return null;
  if (reminder.type === "once") return null; // one-timers use delayed publish

  const cron = istReminderToUTCCron(reminder);
  if (!cron) return null;

  const account = await pickAccountForNewSchedule();
  if (!account) return null;

  try {
    const res = await fetch(`${QSTASH_BASE}/schedules`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destination: cronUrl(reminder.id),
        cron,
      }),
    });
    if (!res.ok) {
      console.error(`[qstash] schedule create failed (acct ${account.index}):`, res.status, await res.text());
      return null;
    }
    const json = await res.json();
    if (!json.scheduleId) return null;
    return { scheduleId: json.scheduleId, accountIndex: account.index };
  } catch (e) {
    console.error("[qstash] schedule create error:", e);
    return null;
  }
}

/** Delete a QStash schedule on the account that created it. */
export async function deleteQStashSchedule(
  scheduleId: string | null | undefined,
  accountIndex?: number | null
): Promise<void> {
  if (!scheduleId || !isQStashConfigured()) return;
  const account = accountForIndex(accountIndex) ?? primaryAccount();
  if (!account) return;
  try {
    await fetch(`${QSTASH_BASE}/schedules/${scheduleId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${account.token}` },
    });
  } catch (e) {
    console.error("[qstash] schedule delete error:", e);
  }
}

/**
 * One-time reminders: publish a delayed message that fires at the exact time.
 * QStash max delay is 7 days — for further-out one-timers, fall back to polling
 * (nextRunAt comparison) until within 7 days. Publishes rotate across pooled
 * accounts to spread quota usage.
 */
export async function publishOneTimeQStash(reminder: {
  id: string;
  nextRunAt: Date | null;
}): Promise<boolean> {
  if (!isQStashConfigured() || !reminder.nextRunAt) return false;
  const delaySec = Math.floor((reminder.nextRunAt.getTime() - Date.now()) / 1000);
  if (delaySec <= 0 || delaySec > 6 * 24 * 60 * 60) return false; // >6 days out: let poll handle later
  const account = pickAccountForPublish();
  if (!account) return false;
  try {
    const res = await fetch(`${QSTASH_BASE}/publish/${encodeURIComponent(cronUrl(reminder.id))}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
        // Upstash delay header (seconds)
        "Upstash-Delay": `${delaySec}s`,
      },
      body: JSON.stringify({ rid: reminder.id }),
    });
    return res.ok;
  } catch (e) {
    console.error("[qstash] publish error:", e);
    return false;
  }
}

// ============================================================
//  Create / update / delete a reminder (DB + QStash together)
// ============================================================

export async function createReminder(userId: string, input: ReminderInput) {
  const nextRunAt = computeNextRun(input);
  if (!nextRunAt && input.type !== "once") {
    throw new Error("Could not compute the next run time — check the time and repeat settings.");
  }
  if (input.type === "once" && nextRunAt && nextRunAt.getTime() <= Date.now()) {
    throw new Error("That time is already in the past — pick a future date/time.");
  }

  const row = await db.scheduledNotification.create({
    data: {
      userId,
      type: input.type,
      time: input.time,
      date: input.date ?? null,
      daysOfWeek: JSON.stringify(input.daysOfWeek ?? []),
      dayOfMonth: input.dayOfMonth ?? null,
      timezone: input.timezone ?? "Asia/Kolkata",
      nextRunAt,
      schedule: "", // legacy field unused for v2 rows
      title: input.title ?? "Khata",
      message: input.message,
      isActive: true,
    },
  });

  // Exact-time delivery via QStash (best-effort; poll is the fallback)
  if (row.isActive) {
    if (row.type === "once") {
      await publishOneTimeQStash({ id: row.id, nextRunAt: row.nextRunAt });
    } else {
      const created = await createQStashScheduleForReminder(row);
      if (created) {
        await db.scheduledNotification.update({
          where: { id: row.id },
          data: { qstashScheduleId: created.scheduleId, qstashAccount: created.accountIndex },
        });
      }
    }
  }

  return row;
}

export async function deleteReminder(userId: string, id: string) {
  const row = await db.scheduledNotification.findFirst({ where: { id, userId } });
  if (!row) return;
  await deleteQStashSchedule(row.qstashScheduleId, row.qstashAccount);
  await db.scheduledNotification.delete({ where: { id: row.id } }).catch(() => {});
}

export async function pauseReminder(userId: string, id: string, isActive: boolean) {
  const row = await db.scheduledNotification.findFirst({ where: { id, userId } });
  if (!row) return;
  if (!isActive && row.qstashScheduleId) {
    await deleteQStashSchedule(row.qstashScheduleId, row.qstashAccount);
  }
  await db.scheduledNotification.update({
    where: { id: row.id },
    data: {
      isActive,
      qstashScheduleId: isActive ? null : row.qstashScheduleId,
      nextRunAt: isActive ? computeNextRun(row) : row.nextRunAt,
    },
  });
  if (isActive && row.type !== "once") {
    // Re-register the exact-time schedule on resume
    const created = await createQStashScheduleForReminder(row);
    if (created) {
      await db.scheduledNotification.update({
        where: { id: row.id },
        data: { qstashScheduleId: created.scheduleId, qstashAccount: created.accountIndex },
      });
    }
  }
}

/** Human-readable description for UI lists (NO cron syntax ever shown). */
export function describeReminder(rem: ReminderShape): string {
  const [hhStr, mmStr] = (rem.time ?? "20:00").split(":");
  const hh = parseInt(hhStr ?? "20", 10);
  const mm = (mmStr ?? "00").padStart(2, "0");
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const time = `${h12}:${mm} ${ampm}`;

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (rem.type === "once" && rem.date) {
    const d = new Date(`${rem.date}T00:00:00`);
    const ds = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    return `Once · ${ds} at ${time}`;
  }
  if (rem.type === "weekly") {
    const days = parseDays(rem.daysOfWeek);
    if (days.length === 0) return `Weekly at ${time}`;
    const ds = days.map((d) => DAYS[((d % 7) + 7) % 7]).join(", ");
    return `Weekly on ${ds} at ${time}`;
  }
  if (rem.type === "monthly") {
    return `Monthly on day ${rem.dayOfMonth ?? 1} at ${time}`;
  }
  return `Daily at ${time}`;
}
