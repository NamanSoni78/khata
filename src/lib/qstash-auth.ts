/**
 * QStash fire-request authentication via a URL-embedded HMAC key.
 * ==============================================================
 *
 * THE V1.6 PROBLEM THIS SOLVES
 * -----------------------------
 * When a QStash schedule fires, it POSTs to our cron endpoint WITHOUT a
 * bearer token — the only credential it attaches is the `Upstash-Signature`
 * header (a JWT signed with the account's signing key). Our cron route could
 * only verify that signature if `QSTASH_CURRENT_SIGNING_KEY` /
 * `QSTASH_NEXT_SIGNING_KEY` were set in the deployment env. When a user sets
 * only `QSTASH_TOKEN` (the common case — it's all you need to CREATE
 * schedules), every scheduled fire was answered with 401 Unauthorized:
 * schedules existed, fired on time at Upstash, and were rejected at our door.
 * The reminder never delivered. TEST notifications kept working because
 * /api/notifications/test is hit directly by the browser and never passes
 * through the cron route — exactly the user-visible symptom
 * "schedule created successfully, test sent, but the notification didn't come".
 *
 * THE FIX — proof-of-origin rides INSIDE the destination URL
 * ----------------------------------------------------------
 * When we mint the destination URL for a schedule
 * (`…/api/notifications/cron?rid=<id>`), we append `&k=<hmac>` where
 *
 *   k = hex( HMAC-SHA256( key = <a pooled QSTASH_TOKEN>, msg = rid ) )[0..24]
 *
 * Only our server can mint that value (it requires the token), QStash
 * delivers the URL verbatim, and the cron route accepts the request when
 * `k` matches the HMAC of `rid` under ANY pooled token. No new env vars, no
 * Upstash dashboard setup, nothing to configure — fire requests authenticate
 * out of the box.
 *
 * SECURITY notes
 * --------------
 * - Knowing `rid` alone is useless: the attacker also needs the token to
 *   compute `k`.
 * - Knowing the full URL (QStash + our DB only) lets its holder trigger that
 *   ONE reminder; the route still gates by due-ness (±10 min) and isActive,
 *   so the worst case is a slightly-early single fire. Acceptable for
 *   reminder triggers; the token itself never appears in the URL.
 * - The comparison is length-checked and XOR-accumulated (timing-safe shape).
 */

/**
 * Compute the URL auth key for a reminder id under one account token.
 * Returns 24 hex chars (96 bits). Uses Web Crypto (global in Node 15+ and
 * all evergreen browsers) — no node:crypto import needed on Vercel.
 */
export async function cronUrlAuthKey(rid: string, token: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rid));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 24);
}

/**
 * All acceptable URL auth keys for a rid — one per pooled QSTASH_TOKEN.
 * A schedule created on account N keeps working even if the pool order
 * changes later, as long as that account's token is still pooled.
 */
export async function allCronUrlAuthKeys(rid: string, tokens: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of tokens) {
    try {
      out.push(await cronUrlAuthKey(rid, t));
    } catch {
      // Web Crypto hiccup — skip this token's key rather than fail the batch.
    }
  }
  return out;
}

/** Timing-safe-shaped hex comparison (length check + XOR accumulate). */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify `?k=` from an incoming cron request against the acceptable keys.
 * `rid` must already be validated (cuid-ish charset) — it is the HMAC message.
 */
export async function verifyCronUrlKey(
  rid: string,
  provided: string | null,
  tokens: string[]
): Promise<boolean> {
  if (!provided || !/^[0-9a-f]{24}$/.test(provided)) return false;
  const expected = await allCronUrlAuthKeys(rid, tokens);
  return expected.some((k) => safeEqualHex(k, provided));
}
