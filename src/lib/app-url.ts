/**
 * App base-URL resolution — ONE source of truth for every place that needs
 * an absolute URL to this deployment (QStash destinations, in-process
 * scheduler loopback, SEO metadata, sitemap, robots, JSON-LD).
 *
 * WHY THIS EXISTS
 * --------------
 * Vercel log seen in production:
 *   [qstash] schedule create failed (acct 0): 400
 *   { "error": "invalid destination url: endpoint has invalid scheme,
 *                add http:// or https://" }
 *
 * Root cause: NEXT_PUBLIC_APP_URL was set WITHOUT a scheme
 * (e.g. "khata.namansoni.in"). QStash — correctly — refused the destination.
 * The old code used the env value verbatim, so every scheduled notification
 * silently failed to register its exact-time delivery.
 *
 * This module makes URL construction bullet-proof instead of trusting the
 * operator to type the scheme:
 *   - "" / whitespace            → falls through to the next source
 *   - "khata.namansoni.in"       → https://khata.namansoni.in
 *   - "//khata.namansoni.in"     → https://khata.namansoni.in   (protocol-relative)
 *   - "https://khata.namansoni.in/"     → https://khata.namansoni.in   (trailing /)
 *   - "https://khata.namansoni.in/Path" → https://khata.namansoni.in   (path stripped)
 *   - "localhost:3000"           → http://localhost:3000        (dev gets http)
 *   - "http://10.0.0.5:3000"     → kept verbatim                (explicit scheme wins)
 *
 * Resolution order: NEXT_PUBLIC_APP_URL → VERCEL_PROJECT_PRODUCTION_URL →
 * VERCEL_URL → http://localhost:3000. (The Vercel-injected vars never carry
 * a scheme, so https:// is added for them.)
 */

/** Strip protocol-relative prefixes ("//host"). */
function stripProtocolRelative(v: string): string {
  let out = v;
  while (out.startsWith("//")) out = out.slice(2);
  return out;
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

/**
 * Normalize any user-supplied origin-ish string into a valid absolute origin
 * (scheme + host[:port], no path, no trailing slash). Returns null when
 * nothing usable remains (caller falls through to the next source).
 */
export function normalizeAppUrl(raw: string | null | undefined): string | null {
  let v = (raw ?? "").trim();
  if (!v) return null;
  v = stripProtocolRelative(v);

  // Explicit scheme? Keep it, but reduce to the ORIGIN only (drop any
  // path / query / hash and trailing slashes).
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]*)$/.exec(v);
  if (schemeMatch) {
    const host = schemeMatch[2].split(/[/?#]/, 1)[0];
    if (!host) return null;
    return `${schemeMatch[1].toLowerCase()}://${host}`;
  }

  // No scheme: infer one. Localhost-family hosts get http; everything else
  // (public domains behind Vercel/CDNs) gets https.
  const host = v.split(/[/?#]/, 1)[0];
  if (!host) return null;
  const scheme = LOCAL_HOST_RE.test(host) ? "http" : "https";
  return `${scheme}://${host}`;
}

/**
 * The deployment's absolute base origin. NEVER throws, NEVER returns a
 * scheme-less or path-bearing value — safe for `new URL(...)` and for
 * QStash destinations.
 */
export function appBaseUrl(): string {
  return (
    normalizeAppUrl(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeAppUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ??
    normalizeAppUrl(process.env.VERCEL_URL) ??
    "http://localhost:3000"
  );
}
