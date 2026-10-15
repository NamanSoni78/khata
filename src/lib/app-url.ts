/**
 * App base-URL resolution — ONE source of truth for every place that needs
 * an absolute URL to this deployment (QStash destinations, in-process
 * scheduler loopback, SEO metadata, sitemap, robots, JSON-LD).
 *
 * WHY THIS EXISTS
 * --------------
 * Vercel log seen in production (twice, across two "fixed" attempts):
 *   [qstash] schedule create failed (acct 0): 400
 *   { "error": "invalid destination url: endpoint has invalid scheme,
 *                add http:// or https://" }
 *
 * Root causes layered on top of each other:
 *   1. NEXT_PUBLIC_APP_URL was set WITHOUT a scheme ("khata.namansoni.in").
 *   2. NEXT_PUBLIC_* vars are INLINED AT BUILD TIME by Next.js — editing the
 *      value in the Vercel dashboard does nothing until a redeploy, so the
 *      server bundle kept serving the stale scheme-less value even after the
 *      env was "fixed".
 *   3. Values pasted WITH quotes ("https://khata.namansoni.in") produce a
 *      garbage-but-scheme-bearing string that defeats naive normalization
 *      and never falls through to healthier sources.
 *
 * THE ROBUST FIX
 * --------------
 * For anything that runs inside a REQUEST (creating/scheduling/reminders),
 * derive the origin from the request itself: the platform (Vercel) always
 * sets x-forwarded-host / x-forwarded-proto to the REAL public host the
 * client just used. That is by definition a URL QStash can call back.
 * Env vars are only the fallback (for request-less contexts like the
 * in-process scheduler interval):
 *
 *   request headers  →  APP_URL (runtime)  →  NEXT_PUBLIC_APP_URL (build)
 *   →  VERCEL_PROJECT_PRODUCTION_URL  →  VERCEL_URL  →  localhost
 *
 * Every candidate is run through normalizeAppUrl(), which now:
 *   - strips surrounding quotes (single or double — common paste mistake)
 *   - strips protocol-relative prefixes ("//host")
 *   - reduces to origin only (no path/query/hash, no trailing slash)
 *   - infers https (http for localhost-family)
 *   - VALIDATES the result with new URL() — unparsable candidates return
 *     null and the chain falls through instead of emitting garbage.
 */

/** Strip surrounding quotes (single or double) — "https://x" / 'https://x'. */
function stripWrappingQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1).trim();
    }
  }
  return v;
}

/** Strip protocol-relative prefixes ("//host"). */
function stripProtocolRelative(v: string): string {
  let out = v;
  while (out.startsWith("//")) out = out.slice(2);
  return out;
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

/** True when s is a parsable absolute http(s) origin with a sane hostname. */
function isUsableOrigin(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // new URL() accepts junk like "!!bad!!" as a hostname — require
    // domain-ish characters so garbage falls through the chain instead.
    return /^[a-zA-Z0-9.\-:\[\]]+$/.test(u.hostname) && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Normalize any user-supplied origin-ish string into a valid absolute origin
 * (scheme + host[:port], no path, no trailing slash). Returns null when
 * nothing usable remains (caller falls through to the next source).
 */
export function normalizeAppUrl(raw: string | null | undefined): string | null {
  let v = stripWrappingQuotes((raw ?? "").trim());
  if (!v) return null;
  v = stripProtocolRelative(v);

  // Explicit scheme? Keep it, but reduce to the ORIGIN only (drop any
  // path / query / hash and trailing slashes).
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]*)$/.exec(v);
  if (schemeMatch) {
    const host = schemeMatch[2].split(/[/?#]/, 1)[0];
    if (!host) return null;
    const candidate = `${schemeMatch[1].toLowerCase()}://${host}`;
    return isUsableOrigin(candidate) ? candidate : null;
  }

  // No scheme: infer one. Localhost-family hosts get http; everything else
  // (public domains behind Vercel/CDNs) gets https.
  const host = v.split(/[/?#]/, 1)[0];
  if (!host) return null;
  // Reject hosts that still contain quote/backtick garbage.
  if (/["'`\s]/.test(host)) return null;
  const scheme = LOCAL_HOST_RE.test(host) ? "http" : "https";
  const candidate = `${scheme}://${host}`;
  return isUsableOrigin(candidate) ? candidate : null;
}

/**
 * The deployment's absolute base origin from ENV ONLY (no request context).
 * NEVER throws, NEVER returns a scheme-less, path-bearing, or unparsable
 * value — safe for `new URL(...)` and for QStash destinations.
 *
 * Order: APP_URL (plain runtime var — never build-inlined) →
 * NEXT_PUBLIC_APP_URL (build-inlined; still the most common setup) →
 * VERCEL_PROJECT_PRODUCTION_URL → VERCEL_URL (both runtime-injected by the
 * Vercel platform, always scheme-less) → http://localhost:3000.
 */
export function appBaseUrl(): string {
  return (
    normalizeAppUrl(process.env.APP_URL) ??
    normalizeAppUrl(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeAppUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ??
    normalizeAppUrl(process.env.VERCEL_URL) ??
    "http://localhost:3000"
  );
}

/**
 * Derive the app's public origin from the LIVE REQUEST — the most reliable
 * source that exists. Vercel (and every proxy that matters) sets:
 *   x-forwarded-proto: https
 *   x-forwarded-host:  khata.namansoni.in
 * exactly to the host the client just reached us on. A callback URL built
 * from these headers is, by construction, reachable from the public
 * internet — which is precisely what QStash needs.
 *
 * Preference order: x-forwarded-host → host header → req.nextUrl.origin.
 * All candidates go through normalizeAppUrl() (localhost gets http, garbage
 * gets dropped). Returns null when nothing usable is found.
 */
export function originFromRequest(req: {
  headers: { get(name: string): string | null };
  nextUrl?: { origin?: string };
  url?: string;
}): string | null {
  const h = req.headers;

  // 1. x-forwarded-host + x-forwarded-proto (platform-set, correct on Vercel)
  const fwdHost = h.get("x-forwarded-host")?.split(",")[0]?.trim();
  const fwdProto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (fwdHost) {
    // Localhost-family hosts always get http — a proxied dev/preview host
    // is loopback traffic regardless of what the proto header claims.
    if (LOCAL_HOST_RE.test(fwdHost)) {
      const local = normalizeAppUrl(`http://${fwdHost}`);
      if (local) return local;
    }
    if (fwdProto && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(fwdProto)) {
      const viaProto = normalizeAppUrl(`${fwdProto}://${fwdHost}`);
      if (viaProto) return viaProto;
    }
    const normalized = normalizeAppUrl(fwdHost);
    if (normalized) return normalized;
  }

  // 2. Plain host header (dev server, direct exposure)
  const host = h.get("host")?.trim();
  if (host) {
    const normalized = normalizeAppUrl(host);
    if (normalized) return normalized;
  }

  // 3. Next's own reconstruction (req.url on App Router route handlers)
  try {
    const origin = req.nextUrl?.origin ?? new URL(req.url ?? "").origin;
    const normalized = normalizeAppUrl(origin);
    if (normalized) return normalized;
  } catch {
    /* not parseable — fall through */
  }

  return null;
}

/** True when the URL's host is the loopback family. */
export function isLocalhostUrl(url: string): boolean {
  try {
    return LOCAL_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Best-effort base URL for callback/destination construction:
 * request-derived origin when available (always inside a route handler),
 * otherwise the env chain. The result is ALWAYS a valid http(s) origin.
 */
export function appBaseUrlFromRequest(
  req: Parameters<typeof originFromRequest>[0]
): string {
  return originFromRequest(req) ?? appBaseUrl();
}
