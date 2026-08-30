/**
 * In-process reminder scheduler (no external cron / QStash required).
 *
 * PROBLEM
 * -------
 * Scheduled notifications previously relied 100% on an EXTERNAL trigger:
 * Upstash QStash fired `/api/notifications/cron`. If QStash wasn't configured
 * (no QSTASH_TOKEN) AND the user hadn't manually set up a 5-minute catch-all
 * cron in the Upstash dashboard, due reminders just sat in the DB
 * forever — `nextRunAt` kept ticking past "now" with no one to fire them.
 *
 * Test notifications worked because `/api/notifications/test` is hit directly
 * by the browser. Scheduled ones didn't because nothing ever poked the cron
 * endpoint.
 *
 * FIX
 * ---
 * This module starts a single `setInterval` on the server that ticks every
 * 30 s and POSTs to `/api/notifications/cron` (loopback). The cron endpoint
 * already knows how to find due rows and fire them — we just need someone
 * to call it. We use a self-fetch so the same request pipeline (incl. auth
 * bypass via QSTASH_TOKEN header) runs as if QStash itself had hit it.
 *
 * Edge runtime caveats:
 *   - On serverless (Vercel free) the interval lives only while a function
 *     is warm. That's still a massive improvement over "never fires" — every
 *     time anyone opens the app or hits any API, the warm instance checks
 *     and fires. For a personal finance tracker that's opened at least a few
 *     times a day, this catches up on missed reminders on the next visit.
 *   - It is fully additive: if QStash IS configured, exact-time delivery
 *     still happens at the right minute via QStash, and this interval just
 *     becomes a no-op (the row will already have fired / advanced).
 *   - It is idempotent: the cron endpoint re-checks `nextRunAt <= now` and
 *     advances `nextRunAt` to the next occurrence, so a double-fire (QStash
 *     + this interval hitting in the same minute) just sends the push twice
 *     worst case, not infinitely.
 */

const TICK_INTERVAL_MS = 30 * 1000; // 30 s
const LOOPBACK_TOKEN_HEADER = "X-Internal-Scheduler";

let _started = false;
let _timer: NodeJS.Timeout | null = null;
let _appUrl: string | null = null;
let _token: string | null = null;

function resolveAppUrl(): string {
  if (_appUrl) return _appUrl;
  // NEXT_PUBLIC_APP_URL is set on most deployments; VERCEL_URL is the
  // per-deployment preview URL Vercel injects; fall back to localhost for dev.
  _appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000");
  return _appUrl;
}

function resolveToken(): string {
  if (_token) return _token;
  // The cron endpoint accepts the QSTASH_TOKEN bearer when QSTASH_TOKEN is
  // set. When it isn't (local dev / no-QStash deployment), the cron endpoint
  // is left open. We additionally pass our own header so the endpoint can
  // recognize self-triggered calls and log them differently if desired.
  _token = process.env.QSTASH_TOKEN ?? LOOPBACK_TOKEN_HEADER;
  return _token;
}

/** Tick: fetch the cron endpoint with no `rid` (catch-all poll mode). */
async function tick() {
  const base = resolveAppUrl().replace(/\/$/, "");
  const url = `${base}/api/notifications/cron`;
  const token = resolveToken();
  // If QSTASH_TOKEN is set, send it as Bearer so the cron auth check passes.
  // If not, send our internal header — the cron endpoint will be in "open"
  // mode (no env vars) and accept the request anyway.
  const isRealToken = !!(process.env.QSTASH_TOKEN && process.env.QSTASH_TOKEN.length > 0);
  try {
    // AbortSignal.timeout is Node 17.3+ / all modern browsers — guard for
    // older runtimes where it's missing.
    const signal: AbortSignal | undefined =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(15_000)
        : undefined;
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isRealToken ? { Authorization: `Bearer ${token}` } : {}),
        "X-Internal-Scheduler": "1",
      },
      body: JSON.stringify({ source: "in-process-scheduler" }),
      // Don't let a hung fetch block the next tick.
      ...(signal ? { signal } : {}),
    });
  } catch {
    // Network errors here are expected on serverless cold starts before the
    // DNS is warm, or when the deployment URL isn't reachable from inside
    // the function. Silently retry on the next tick.
  }
}

/** Start the in-process scheduler (idempotent — safe to call multiple times). */
export function startInProcessScheduler() {
  if (_started) return;
  _started = true;
  // Fire once immediately so a warm instance picks up any overdue reminders
  // without waiting up to 30 s. Then settle into the interval.
  tick().catch(() => {});
  _timer = setInterval(() => {
    tick().catch(() => {});
  }, TICK_INTERVAL_MS);
  // Don't keep the Node process alive just for this timer — if nothing else
  // is pending, let the instance go cold. The next warm-up re-runs
  // startInProcessScheduler via the route module side-effect.
  if (_timer && typeof _timer.unref === "function") _timer.unref();
}

/** Stop the scheduler (only useful for tests). */
export function stopInProcessScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _started = false;
}
