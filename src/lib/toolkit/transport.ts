/**
 * TOOLKIT · HTTP TRANSPORT (timeout + retry + backoff)
 * =====================================================
 *
 * Free-tier LLM endpoints (Groq, OpenRouter, DeepSeek…) fail transiently
 * all the time: 429 rate limits, 502/503 cold starts, connection resets,
 * 60s hangs on long generations. A single failed fetch used to kill the
 * whole agent turn — this layer makes those invisible.
 *
 * - AbortController timeout per attempt (default 90s — long generations)
 * - Retries network errors, 429 (honors Retry-After), 500/502/503/504
 * - Exponential backoff + jitter: 600ms · 1800ms · 5400ms (capped)
 * - Never retries 4xx (except 429) — those are deterministic failures
 */

export interface TransportOptions {
  /** Per-attempt timeout. Default 90_000. */
  timeoutMs?: number;
  /** Max attempts (1 = no retry). Default 3. */
  retries?: number;
  /** Base delay for backoff. Default 600ms. */
  baseDelayMs?: number;
}

export class TransportError extends Error {
  status: number;
  bodyText: string;
  attempts: number;
  retriable: boolean;

  constructor(message: string, opts: { status?: number; bodyText?: string; attempts?: number; retriable?: boolean } = {}) {
    super(message);
    this.name = "TransportError";
    this.status = opts.status ?? 0;
    this.bodyText = opts.bodyText ?? "";
    this.attempts = opts.attempts ?? 1;
    this.retriable = opts.retriable ?? false;
  }
}

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504, 522, 524, 529]);
const SLEEP_CAP_MS = 8_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Backoff delay for attempt n (0-based): base * 3^n + jitter, capped. */
export function backoffDelay(attempt: number, baseMs = 600): number {
  const exp = Math.min(baseMs * Math.pow(3, attempt), SLEEP_CAP_MS);
  const jitter = Math.random() * Math.min(250, exp * 0.25);
  return Math.round(exp + jitter);
}

/**
 * fetch with timeout + retry. Throws TransportError only after all
 * attempts are exhausted (or immediately for non-retriable failures).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: TransportOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const maxAttempts = Math.max(1, opts.retries ?? 3);
  const baseDelay = opts.baseDelayMs ?? 600;

  let lastError: TransportError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });

      // Success — or a deterministic client failure we must NOT retry
      if (res.ok || !RETRIABLE_STATUS.has(res.status)) {
        return res;
      }

      // Retriable status (429/5xx) — maybe honor Retry-After
      const bodyText = await res.clone().text().catch(() => "");
      lastError = new TransportError(
        `HTTP ${res.status} from ${hostOf(url)}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`,
        { status: res.status, bodyText, attempts: attempt + 1, retriable: true }
      );

      if (attempt < maxAttempts - 1) {
        let delay = backoffDelay(attempt, baseDelay);
        const retryAfter = res.headers.get("retry-after");
        if (retryAfter) {
          const ra = Number(retryAfter);
          if (Number.isFinite(ra) && ra > 0) {
            delay = Math.min(Math.round(ra * 1000), SLEEP_CAP_MS);
          } else if (!Number.isFinite(ra)) {
            // HTTP-date form
            const raDate = Date.parse(retryAfter);
            if (!isNaN(raDate)) delay = Math.min(Math.max(raDate - Date.now(), 0), SLEEP_CAP_MS);
          }
        }
        await sleep(delay);
        continue;
      }
    } catch (e: unknown) {
      // Network error / abort / DNS — all retriable
      const isAbort = e instanceof Error && e.name === "AbortError";
      lastError = new TransportError(
        isAbort ? `Timeout after ${timeoutMs}ms calling ${hostOf(url)}` : `${String((e as Error)?.message ?? e)} calling ${hostOf(url)}`,
        { attempts: attempt + 1, retriable: true }
      );
      if (attempt < maxAttempts - 1) {
        await sleep(backoffDelay(attempt, baseDelay));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ??
    new TransportError(`Request to ${hostOf(url)} failed after ${maxAttempts} attempts`, {
      attempts: maxAttempts,
      retriable: true,
    })
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Read a non-OK response into a compact, safe error message.
 * Some providers return HTML error pages — strip tags so logs stay readable.
 */
export async function readErrorMessage(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* body already consumed */
  }
  text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return `HTTP ${res.status}: ${text.slice(0, 400) || res.statusText}`;
}
