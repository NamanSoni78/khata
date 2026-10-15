import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendPushToUser, resolveMessageTemplate, isWebPushConfigured } from "@/lib/notifications/push";
import { computeNextRun } from "@/lib/scheduler";
import { allTokens, allSigningKeys } from "@/lib/qstash-pool";
// Self-start the in-process scheduler the first time this module loads on
// any warm instance. It's idempotent and unref'd, so it never blocks shutdown.
import { startInProcessScheduler } from "@/lib/notifications/scheduler";
startInProcessScheduler();

/**
 * Reminder delivery endpoint — hit by Upstash QStash (Vercel-free friendly)
 * OR by the in-process scheduler (see @/lib/notifications/scheduler.ts).
 *
 * TWO MODES:
 *  1. EXACT-TIME (preferred when QStash is configured): QStash schedules/
 *     delayed-publishes hit /api/notifications/cron?rid=<reminderId> at the
 *     exact minute.
 *  2. CATCH-ALL POLL: one QStash cron job (every 5 min) OR the in-process
 *     scheduler (every 30 s) hits this endpoint without rid; it fires every
 *     active reminder whose nextRunAt is due. Catches missed exact fires,
 *     legacy rows, and deployments without QSTASH_TOKEN.
 *
 * AUTH — request must pass ONE of:
 *  - Upstash server signature (JWT HS256 with QSTASH_CURRENT_SIGNING_KEY or
 *    QSTASH_NEXT_SIGNING_KEY) in the `Upstash-Signature` header
 *  - Bearer token matching QSTASH_TOKEN
 *  - Internal scheduler header `X-Internal-Scheduler: 1` (self-call only —
 *    the request originates from this same server process, so it can't be
 *    spoofed from outside without already being inside the deployment)
 *  - If NEITHER env var is set, the endpoint stays open (local dev).
 */
export async function POST(req: NextRequest) {
  const auth = await verifyQStashRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isWebPushConfigured()) {
    return NextResponse.json({ skipped: true, reason: "Web Push not configured" });
  }

  const url = new URL(req.url);
  const rid = url.searchParams.get("rid");
  const now = new Date();

  // ---- Mode 1: exact-time fire for a specific reminder ----
  if (rid) {
    const rem = await db.scheduledNotification.findFirst({
      where: { id: rid, isActive: true },
    });
    if (!rem) return NextResponse.json({ ok: true, fired: 0, reason: "not found or inactive" });
    // Guard: only fire if actually due (or within a 10-min early/late window for
    // one-timers whose delayed publish drifted).
    const due = rem.nextRunAt ? rem.nextRunAt.getTime() <= now.getTime() + 10 * 60 * 1000 : true;
    if (!due) {
      return NextResponse.json({ ok: true, fired: 0, reason: "not due yet", nextRunAt: rem.nextRunAt });
    }
    const r = await fireReminder(rem, now);
    return NextResponse.json({ ok: true, fired: r.sent > 0 ? 1 : 0, ...r });
  }

  // ---- Mode 2: catch-all poll — fire everything due ----
  const dueRows = await db.scheduledNotification.findMany({
    where: { isActive: true, nextRunAt: { lte: now } },
    take: 200,
  });

  let fired = 0;
  for (const rem of dueRows) {
    const r = await fireReminder(rem, now);
    if (r.sent > 0) fired++;
  }

  // Legacy rows (pre-v2, cron/ISO strings) — best-effort migration to v2 fields
  try {
    const legacy = await db.scheduledNotification.findMany({
      where: { isActive: true, nextRunAt: null, schedule: { not: "" } },
      take: 100,
    });
    for (const row of legacy) {
      const iso = /^\d{4}-\d{2}-\d{2}T/.test(row.schedule);
      const next = iso ? new Date(row.schedule) : computeNextRun(row);
      await db.scheduledNotification.update({
        where: { id: row.id },
        data: { nextRunAt: next },
      });
    }
  } catch (e) {
    console.error("[cron] legacy migration error:", e);
  }

  return NextResponse.json({
    ok: true,
    checked: dueRows.length,
    fired,
    at: now.toISOString(),
  });
}

async function fireReminder(
  rem: {
    id: string;
    userId: string;
    type: string;
    time: string;
    date: string | null;
    daysOfWeek: string;
    dayOfMonth: number | null;
    title: string;
    message: string;
    lastFiredAt: Date | null;
  },
  now: Date
): Promise<{ sent: number; failed: number }> {
  const message = await resolveMessageTemplate(rem.userId, rem.message);
  const result = await sendPushToUser(rem.userId, {
    title: rem.title || "Khata",
    body: message,
    url: "/",
  });

  const isOneTime = rem.type === "once";
  await db.scheduledNotification.update({
    where: { id: rem.id },
    data: {
      lastFiredAt: now,
      isActive: !isOneTime,
      nextRunAt: isOneTime ? null : computeNextRun(rem),
    },
  });
  return result;
}

// ============================================================
//  QStash auth — server signature (JWT HS256) or bearer token
// ============================================================

async function verifyQStashRequest(req: NextRequest): Promise<{ ok: boolean; reason?: string }> {
  // Multi-account support: QSTASH_TOKEN / signing keys may hold several
  // ";"-separated accounts. Inbound requests are accepted if they match ANY
  // account's bearer token or ANY account's signing key.
  const tokens = allTokens();
  const signingKeys = allSigningKeys();

  // No auth configured (local dev) — allow.
  if (tokens.length === 0 && signingKeys.length === 0) return { ok: true };

  // 0. Internal self-trigger from the in-process scheduler. The header value
  //    isn't a secret (it's just "1") — but a request bearing it can only have
  //    come from our own server process, which is the whole point. This lets the
  //    scheduler POST to itself when QSTASH_TOKEN is set but we still want the
  //    belt-and-suspenders poll to run.
  if (req.headers.get("x-internal-scheduler") === "1") {
    return { ok: true };
  }

  // 1. Bearer token check (any pooled account)
  if (tokens.length > 0) {
    const authHeader = req.headers.get("authorization");
    const bearer = authHeader?.replace(/^Bearer\s+/i, "");
    if (bearer && tokens.includes(bearer)) return { ok: true };
  }

  // 2. Upstash server signature check (JWT in Upstash-Signature header).
  //    Upstash may send several signatures (space-separated) during key rotation.
  const sigHeader = req.headers.get("upstash-signature");
  if (sigHeader && signingKeys.length > 0) {
    for (const sig of sigHeader.split(" ")) {
      for (const key of signingKeys) {
        if (await verifyUpstashJWT(sig, key)) return { ok: true };
      }
    }
  }

  return { ok: false, reason: "unauthorized" };
}

/** Verify an Upstash server-signature JWT (HS256) with Web Crypto. */
async function verifyUpstashJWT(jwt: string, signingKey: string): Promise<boolean> {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const [head, body, sig] = parts;

    // Header must declare HS256
    const header = JSON.parse(atobUrl(head));
    if (header.alg !== "HS256") return false;

    // Signature check: HMAC-SHA256(key, "head.body") base64url
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(`${head}.${body}`));
    const expected = btoaUrl(new Uint8Array(mac));
    if (expected !== sig) return false;

    // Claims check: expiry (Upstash gives ~2 min leeway)
    const claims = JSON.parse(atobUrl(body));
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && claims.exp < nowSec - 120) return false;
    if (typeof claims.nbf === "number" && claims.nbf > nowSec + 120) return false;
    return true;
  } catch {
    return false;
  }
}

function atobUrl(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b + "=".repeat((4 - (b.length % 4)) % 4));
}

function btoaUrl(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
