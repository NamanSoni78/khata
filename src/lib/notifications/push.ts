/**
 * Web Push notification helpers — wraps web-push package with VAPID + DB.
 *
 * Requires env vars:
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY  (string, base64url)
 *   VAPID_PRIVATE_KEY             (string, base64url)
 *   VAPID_SUBJECT                  (optional, e.g., "mailto:admin@example.com")
 *
 * If any are missing, isWebPushConfigured() returns false and UI hides push features.
 *
 * V1.5 — why test notifications were accepted but never SEEN:
 *   every push shared the notification tag "khata-notif" with renotify:false.
 *   When a notification with a tag already exists, browsers (notably Android
 *   Chrome) SILENTLY replace it — no toast, no sound, no vibration. After the
 *   first test, every later test could replace a stale notification and look
 *   like "nothing happened". The service worker now only sets a tag when the
 *   payload carries one, and always sets renotify:true alongside it, so a
 *   tagged notification re-alerts instead of silently swapping. sendPush also
 *   gained TTL + Urgency headers (tests go out with urgency "high" and a
 *   short TTL so they are delivered promptly or dropped, never queued for
 *   days on a powered-off device).
 */
import webPush from "web-push";
import { db } from "@/lib/db";

let _initialized = false;

function init() {
  if (_initialized) return;
  if (!isWebPushConfigured()) return;
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@khata.app",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
  _initialized = true;
}

export function isWebPushConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY
  );
}

export function getVapidPublicKey(): string | null {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null;
}

/** What we put on the wire — the service worker reads all of it. */
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  /** Unique per notification → the SW sets tag + renotify:true (always re-alerts). */
  tag?: string;
  /** Keep the toast on screen until dismissed (tests use this so it can't be missed). */
  requireInteraction?: boolean;
}

export interface PushSendOptions {
  /** Seconds the push service should keep the message if the device is offline. */
  ttl?: number;
  /** very-low | low | normal | high — high wakes sleeping devices. */
  urgency?: "very-low" | "low" | "normal" | "high";
}

/** Friendly per-subscription device label (from stored UA + push endpoint). */
export interface DeviceInfo {
  id: string;
  label: string;
  endpointTail: string;
  subscribedAt: string | null;
}

/**
 * Derive a human label for a subscription row. The keys JSON column carries
 * the subscribing browser's UA (stored since V1.5; older rows fall back to
 * endpoint-domain heuristics).
 */
export function describeDevice(sub: { id: string; endpoint: string; keys: string; createdAt?: Date }): DeviceInfo {
  let meta: any = {};
  try { meta = JSON.parse(sub.keys); } catch {}
  const ua: string = typeof meta?._ua === "string" ? meta._ua : "";

  let label = "This device";
  if (ua) {
    const browser =
      /edg\//i.test(ua) ? "Edge" :
      /opr\//i.test(ua) ? "Opera" :
      /firefox\//i.test(ua) ? "Firefox" :
      /chrome\//i.test(ua) ? "Chrome" :
      /safari\//i.test(ua) ? "Safari" : "Browser";
    const os =
      /android/i.test(ua) ? "Android" :
      /iphone|ipad|ipod/i.test(ua) ? "iOS" :
      /windows/i.test(ua) ? "Windows" :
      /mac os x|macintosh/i.test(ua) ? "macOS" :
      /linux/i.test(ua) ? "Linux" : "";
    label = os ? `${browser} on ${os}` : browser;
  } else if (/fcm\.googleapis\.com/i.test(sub.endpoint)) {
    label = "Chrome-based browser";
  } else if (/updates\.push\.services\.mozilla\.com/i.test(sub.endpoint)) {
    label = "Firefox";
  } else if (/push\.apple\.com/i.test(sub.endpoint)) {
    label = "Safari";
  }

  return {
    id: sub.id,
    label,
    endpointTail: sub.endpoint.slice(-14),
    subscribedAt: sub.createdAt ? sub.createdAt.toISOString() : null,
  };
}

/** All of a user's subscriptions with friendly device labels. */
export async function listDevices(userId: string): Promise<DeviceInfo[]> {
  const subs = await db.pushSubscription.findMany({ where: { userId } });
  return subs.map(describeDevice);
}

/**
 * Send a push notification to a single subscription.
 */
export async function sendPush(
  subscriptionId: string,
  payload: PushPayload,
  opts?: PushSendOptions
): Promise<{ ok: boolean; error?: string }> {
  if (!isWebPushConfigured()) {
    return { ok: false, error: "VAPID keys not configured" };
  }
  init();

  const sub = await db.pushSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return { ok: false, error: "Subscription not found" };

  let keys: any = {};
  try { keys = JSON.parse(sub.keys); } catch {}

  const pushSubscription = {
    endpoint: sub.endpoint,
    // web-push only reads p256dh + auth; the _ua/_subscribedAt metadata that
    // also lives in this JSON is ignored by the library.
    keys: {
      p256dh: keys?.p256dh,
      auth: keys?.auth,
    },
  };

  try {
    await webPush.sendNotification(
      pushSubscription,
      JSON.stringify(payload),
      {
        ...(opts?.ttl !== undefined ? { TTL: opts.ttl } : {}),
        ...(opts?.urgency ? { urgency: opts.urgency } : {}),
      }
    );
    return { ok: true };
  } catch (e: any) {
    if (e?.statusCode === 410 || e?.statusCode === 404) {
      // Subscription expired / invalid — delete it
      await db.pushSubscription.delete({ where: { id: subscriptionId } }).catch(() => {});
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Send a push notification to ALL subscriptions for a user.
 * `errors` carries the first failure reasons (capped) so callers can tell
 * the user WHY a device didn't receive a push instead of guessing.
 * `devices` labels every subscription so "Sent to 1 device" can finally say
 * WHICH device — the invisible-notification mystery is usually a stale
 * subscription on a browser the user isn't looking at.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  opts?: PushSendOptions
): Promise<{ sent: number; failed: number; errors?: string[]; devices: DeviceInfo[] }> {
  const subs = await db.pushSubscription.findMany({ where: { userId } });
  const devices = subs.map(describeDevice);
  let sent = 0, failed = 0;
  const errors: string[] = [];
  for (const s of subs) {
    const r = await sendPush(s.id, payload, opts);
    if (r.ok) sent++;
    else {
      failed++;
      if (r.error) errors.push(r.error);
    }
  }
  return { sent, failed, errors: errors.slice(0, 3), devices };
}

/**
 * Resolve message placeholders for a user:
 *   {today_income} {today_expense} {month_income} {month_expense}
 */
export async function resolveMessageTemplate(userId: string, template: string): Promise<string> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const txns = await db.transaction.findMany({
    where: { userId, timestamp: { gte: startOfMonth } },
  });

  let todayIncome = 0, todayExpense = 0, monthIncome = 0, monthExpense = 0;
  for (const t of txns) {
    const isIncome = t.type === "income" || t.type === "profit" || t.type === "loan_in";
    const isExpense = t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out";
    if (t.timestamp >= startOfToday) {
      if (isIncome) todayIncome += t.amount;
      if (isExpense) todayExpense += t.amount;
    }
    if (isIncome) monthIncome += t.amount;
    if (isExpense) monthExpense += t.amount;
  }

  return template
    .replaceAll("{today_income}", `Rs ${todayIncome}`)
    .replaceAll("{today_expense}", `Rs ${todayExpense}`)
    .replaceAll("{month_income}", `Rs ${monthIncome}`)
    .replaceAll("{month_expense}", `Rs ${monthExpense}`)
    .replaceAll("{date}", now.toLocaleDateString("en-IN"))
    .replaceAll("{time}", now.toLocaleTimeString("en-IN"));
}
