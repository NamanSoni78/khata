/**
 * QStash multi-account pool.
 *
 * The free Upstash QStash tier has per-account quotas. To multiply headroom,
 * the env vars can hold MULTIPLE accounts separated by ";" (or ","):
 *
 *   QSTASH_TOKEN="tokenA;tokenB;tokenC"
 *   QSTASH_CURRENT_SIGNING_KEY="curA;curB;curC"
 *   QSTASH_NEXT_SIGNING_KEY="nextA;nextB;nextC"
 *
 * Each token[i] pairs with signingKey[i] (missing entries are simply absent —
 * uneven lists are fine).
 *
 * Behavior:
 *  - Recurring schedules are spread across accounts (least-loaded first);
 *    the owning account index is stored on the reminder row so deletes hit
 *    the right account.
 *  - One-time delayed publishes rotate round-robin.
 *  - Inbound cron auth accepts ANY account's bearer token or signing keys.
 * A single-account env var works exactly as before.
 */
import { db } from "@/lib/db";

export interface QStashAccount {
  index: number;
  token: string;
  currentSigningKey?: string;
  nextSigningKey?: string;
}

function splitList(env: string | undefined): string[] {
  return (env ?? "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getQStashAccounts(): QStashAccount[] {
  const tokens = splitList(process.env.QSTASH_TOKEN);
  if (tokens.length === 0) return [];
  const cur = splitList(process.env.QSTASH_CURRENT_SIGNING_KEY);
  const next = splitList(process.env.QSTASH_NEXT_SIGNING_KEY);
  return tokens.map((token, i) => ({
    index: i,
    token,
    currentSigningKey: cur[i],
    nextSigningKey: next[i],
  }));
}

export function isQStashConfigured(): boolean {
  return getQStashAccounts().length > 0;
}

/** All bearer tokens (inbound auth). */
export function allTokens(): string[] {
  return getQStashAccounts().map((a) => a.token);
}

/** All signing keys, current + next, across accounts (inbound JWT verification). */
export function allSigningKeys(): string[] {
  const out: string[] = [];
  for (const a of getQStashAccounts()) {
    if (a.currentSigningKey) out.push(a.currentSigningKey);
    if (a.nextSigningKey) out.push(a.nextSigningKey);
  }
  return out;
}

export function accountForIndex(index: number | null | undefined): QStashAccount | null {
  if (index === null || index === undefined) return null;
  return getQStashAccounts().find((a) => a.index === index) ?? null;
}

/** Primary account (index 0) — used when no index is known. */
export function primaryAccount(): QStashAccount | null {
  return getQStashAccounts()[0] ?? null;
}

/**
 * Pick the account for a NEW recurring schedule: least-loaded by active
 * schedule count (falls back to index order). Returns null when QStash
 * isn't configured.
 */
export async function pickAccountForNewSchedule(): Promise<QStashAccount | null> {
  const accounts = getQStashAccounts();
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0];

  const rows = await db.scheduledNotification.groupBy({
    by: ["qstashAccount"],
    where: { isActive: true, qstashAccount: { not: null } },
    _count: { _all: true },
  });
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.qstashAccount !== null) counts.set(r.qstashAccount, r._count._all);
  }
  // Least loaded; ties resolved by index order.
  let best = accounts[0];
  let bestCount = counts.get(best.index) ?? 0;
  for (const a of accounts.slice(1)) {
    const c = counts.get(a.index) ?? 0;
    if (c < bestCount) {
      best = a;
      bestCount = c;
    }
  }
  return best;
}

/** Round-robin account for one-time delayed publishes. */
export function pickAccountForPublish(): QStashAccount | null {
  const accounts = getQStashAccounts();
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0];
  const idx = Math.floor(Date.now() / 60000) % accounts.length; // rotates each minute
  return accounts[idx];
}
