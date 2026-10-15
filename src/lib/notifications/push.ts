/**
 * Web Push notification helpers — wraps web-push package with VAPID + DB.
 *
 * Requires env vars:
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY  (string, base64url)
 *   VAPID_PRIVATE_KEY             (string, base64url)
 *   VAPID_SUBJECT                  (optional, e.g., "mailto:admin@example.com")
 *
 * If any are missing, isWebPushConfigured() returns false and UI hides push features.
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

/**
 * Send a push notification to a single subscription.
 */
export async function sendPush(
  subscriptionId: string,
  payload: { title: string; body: string; url?: string }
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
    keys,
  };

  try {
    await webPush.sendNotification(pushSubscription, JSON.stringify(payload));
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
 */
export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string }
): Promise<{ sent: number; failed: number; errors?: string[] }> {
  const subs = await db.pushSubscription.findMany({ where: { userId } });
  let sent = 0, failed = 0;
  const errors: string[] = [];
  for (const s of subs) {
    const r = await sendPush(s.id, payload);
    if (r.ok) sent++;
    else {
      failed++;
      if (r.error) errors.push(r.error);
    }
  }
  return { sent, failed, errors: errors.slice(0, 3) };
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
