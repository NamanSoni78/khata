import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendPushToUser, resolveMessageTemplate, isWebPushConfigured } from "@/lib/notifications/push";
import { computeNextRun, repairMissingQStashSchedules } from "@/lib/scheduler";
import { allTokens, allSigningKeys } from "@/lib/qstash-pool";
import { verifyCronUrlKey } from "@/lib/qstash-auth";
import { originFromRequest } from "@/lib/app-url";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
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
 * V1.5: the reminder id arrives over THREE redundant channels — the ?rid=
 * query in the destination URL, the X-Reminder-Id header (from QStash's
 * Upstash-Forward-X-Reminder-Id), and the JSON body {rid} that the schedule
 * delivers. Any one of them is enough; if QStash's router ever mangles the
 * query string, delivery still targets the right reminder.
 *
 * V1.6 — THE fix for "schedule created but notification never came":
 * QStash fire requests carry NO bearer token — only an Upstash-Signature
 * header. When signing-key env vars aren't set (the common single-env-var
 * QSTASH_TOKEN setup), every scheduled fire was 401-rejected HERE: schedules
 * fired on time at Upstash and bounced off our own door. Fire requests now
 * also authenticate via the `&k=<hmac>` credential embedded in the schedule's
 * destination URL when it was minted (scheduler.ts + qstash-auth.ts) — no
 * extra env vars needed. The app's own browser poll authenticates with the
 * user's session instead of the old spoofable X-Internal-Scheduler header
 * (that header's value was public "1" — anyone could trigger the catch-all
 * poll with it; the old comment claiming only our server could send it was
 * simply wrong, since the daily app's browser poll sent exactly that header).
 *
 * AUTH — request must pass ONE of:
 *  - Upstash server signature (JWT HS256 with QSTASH_CURRENT_SIGNING_KEY or
 *    QSTASH_NEXT_SIGNING_KEY) in the `Upstash-Signature` header
 *  - Bearer token matching a pooled QSTASH_TOKEN
 *  - V1.6 URL key: `&k=` matching HMAC-SHA256(rid, any pooled QSTASH_TOKEN)
 *    (rid-addressed fire requests only — the credential IS rid-bound)
 *  - V1.6 browser poll: `X-Client-Poll: 1` + a valid daily/dashboard user
 *    session (catch-all polling only — the app's own open tab)
 *  - If NEITHER env var is set, the endpoint stays open (local dev).
 */
export async function POST(req: NextRequest) {
  const auth = await verifyQStashRequest(req);
  if (!auth.ok) {
    // Log WHY (and which methods were even available) — the silent 401 on
    // every scheduled fire is what let this bug hide for three versions.
    console.warn(
      `[cron] auth rejected (${auth.reason ?? "unauthorized"}; ` +
        `available: bearer=${allTokens().length > 0}, ` +
        `signature=${allSigningKeys().length > 0}, url-key=${allTokens().length > 0}, ` +
        `client-poll=session). ` +
        `If this is a QStash fire, its schedule predates V1.6 — the repair pass ` +
        `migrates it automatically (dashboard visit or next catch-all tick).`
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isWebPushConfigured()) {
    return NextResponse.json({ skipped: true, reason: "Web Push not configured" });
  }

  const url = new URL(req.url);

  // Reminder id — query ?rid=, then X-Reminder-Id header (QStash-forwarded),
  // then JSON body {rid} (the schedule's delivered message). All ids are
  // cuids (alphanumeric + -_), so the charset check blocks header/body
  // injection of anything unexpected.
  let rid = url.searchParams.get("rid");
  if (!rid) {
    const hdr = req.headers.get("x-reminder-id");
    if (hdr && /^[A-Za-z0-9_-]{1,64}$/.test(hdr)) rid = hdr;
  }
  if (!rid) {
    const body = await req.json().catch(() => null);
    const b = typeof body?.rid === "string" ? body.rid : null;
    if (b && /^[A-Za-z0-9_-]{1,64}$/.test(b)) rid = b;
  }

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
    // V1.6: the delivery outcome is now VISIBLE in server logs — "schedule
    // fired but nothing happened" is diagnosable from the Vercel console.
    console.log(
      `[cron] reminder ${rid} fired → sent ${r.sent} device(s)` +
        (r.failed > 0 ? `, ${r.failed} failed` : "")
    );
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
    else console.warn(`[cron] poll: reminder ${rem.id} due but sent 0 devices (failed ${r.failed})`);
  }

  // Self-healing: re-register exact-time QStash delivery for reminders whose
  // schedule never got created (e.g. while NEXT_PUBLIC_APP_URL was scheme-less
  // and every create 400'd). The request-derived origin (the host QStash or
  // the daily-app poll just used to reach us) is the healthiest destination
  // — immune to stale build-time-inlined env values. Throttled to one pass /
  // 10 min.
  const repaired = await repairMissingQStashSchedules(
    false,
    originFromRequest(req) ?? undefined
  );

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
    repaired,
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
  // V1.6: reminders now travel with urgency "high" (wakes Doze/sleeping
  // devices — a reminder is exactly the "time-sensitive" case the Urgency
  // header exists for) and a 24h TTL: if the device is offline longer than
  // that, delivering a day-old reminder is noise, so the service drops it.
  const result = await sendPushToUser(
    rem.userId,
    {
      title: rem.title || "Khata",
      body: message,
      url: "/",
    },
    { urgency: "high", ttl: 86400 }
  );

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

  // 1. Bearer token check (any pooled account). The in-process scheduler's
  //    self-fetch carries this whenever QStash is configured. NOTE: QStash's
  //    own fire requests do NOT — see checks 2 and 3.
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

  // 3. V1.6 URL key — HMAC(rid, pooled token) embedded in the destination
  //    URL when the schedule was minted. This is what authenticates QStash
  //    fire POSTs on deployments that set QSTASH_TOKEN but no signing keys
  //    (previously: 401 on EVERY scheduled fire → reminders never delivered
  //    while tests kept working — the exact bug V1.6 exists to kill).
  const url = new URL(req.url);
  const ridParam = url.searchParams.get("rid");
  const keyParam = url.searchParams.get("k");
  if (ridParam && keyParam && /^[A-Za-z0-9_-]{1,64}$/.test(ridParam)) {
    if (await verifyCronUrlKey(ridParam, keyParam, tokens)) return { ok: true };
  }

  // 4. V1.6 browser poll — the daily app's open tab pings the catch-all
  //    every 60s with X-Client-Poll + the user's session cookie. Replaces the
  //    old X-Internal-Scheduler header whose value ("1") was public and thus
  //    spoofable by anyone. Only ever authorizes the CATCH-ALL (no rid) —
  //    firing a specific reminder stays exclusive to QStash channels.
  if (req.headers.get("x-client-poll") === "1" && !ridParam) {
    let user = await getSessionUser(await getSessionToken("daily"), "daily");
    if (!user || user.id === "admin") {
      user = await getSessionUser(await getSessionToken("dashboard"), "dashboard");
    }
    if (user && user.id !== "admin") return { ok: true };
    return { ok: false, reason: "client-poll without a valid session" };
  }

  return { ok: false, reason: "no bearer, no valid signature, no url key, no session" };
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
