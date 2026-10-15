/**
 * CLIENT-SIDE WEB PUSH — one shared, correct implementation.
 * =========================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * "Enable notifications" and "Send test notification" were dead in
 * production, and the cause was silent:
 *
 *   1. THE SERVICE WORKER WAS NEVER REGISTERED. public/sw.js existed (with a
 *      full push + notificationclick handler) but NOTHING in the app ever
 *      called navigator.serviceWorker.register(). `serviceWorker.ready`
 *      therefore NEVER resolved → subscribeToPush() hung forever on its
 *      spinner → no subscription was ever created → no push could ever be
 *      delivered, and /api/notifications/test truthfully reported sent: 0
 *      while the UI claimed success.
 *
 *   2. Notification.requestPermission() was never called. Chrome happens to
 *      prompt implicitly inside pushManager.subscribe(); Firefox, iOS Safari
 *      (installed PWA) and several others do NOT — they require an explicit
 *      permission request first, and permanently remember a dismissal.
 *
 * This module fixes both, once, for every surface that needs push (the daily
 * app settings sheet, the dashboard reminders tab, and the auto-prompt that
 * fires the moment a user sets any notification).
 *
 * Usage:
 *   import { ensurePushEnabled } from "@/lib/push-client";
 *   const res = await ensurePushEnabled(); // permission + SW + subscribe + save
 *   // res: { ok, stage, reason?, permission?, detail? }
 */

export type PushPermission = "granted" | "denied" | "default" | "unsupported";

export interface PushEnableResult {
  ok: boolean;
  /** Where the flow stopped, for precise user messaging. */
  stage:
    | "unsupported"
    | "permission-denied"
    | "permission-dismissed"
    | "sw-register"
    | "sw-ready"
    | "server-key"
    | "subscribe"
    | "save"
    | "already-enabled"
    | "enabled";
  /** Human-readable, actionable explanation (safe to toast verbatim). */
  detail: string;
  permission?: PushPermission;
}

const SW_PATH = "/sw.js";
const SW_READY_TIMEOUT_MS = 10_000;
const SW_REGISTER_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------ */
/* Capability checks                                                    */
/* ------------------------------------------------------------------ */

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function currentPermission(): PushPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as PushPermission;
}

/* ------------------------------------------------------------------ */
/* Service worker — register once, wait with a timeout                  */
/* ------------------------------------------------------------------ */

let _swRegistering: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Register /sw.js (idempotent). Resolves with the registration or null.
 * Never rejects; never hangs — bounded by SW_REGISTER_TIMEOUT_MS.
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(null);
  }
  if (_swRegistering) return _swRegistering;
  _swRegistering = (async () => {
    try {
      // navigator.serviceWorker.register is a no-op re-register when the SW
      // is already active — safe to call on every boot.
      const reg = await withTimeout(
        navigator.serviceWorker.register(SW_PATH, { scope: "/" }),
        SW_REGISTER_TIMEOUT_MS,
        "service worker registration timed out"
      );
      return reg;
    } catch (e) {
      console.error("[push] service worker registration failed:", e);
      return null;
    }
  })();
  return _swRegistering;
}

/** `navigator.serviceWorker.ready` with a timeout — NEVER hangs (the old
 *  code awaited it unbounded, which is exactly how the spinner froze). */
async function waitForServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await withTimeout(
      navigator.serviceWorker.ready,
      SW_READY_TIMEOUT_MS,
      "service worker activation timed out"
    );
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/* ------------------------------------------------------------------ */
/* Permission                                                           */
/* ------------------------------------------------------------------ */

/**
 * Ask for notification permission (the PERMANENT browser prompt) if it
 * hasn't been decided yet. Returns the resulting permission state.
 * "granted"  → notifications will show
 * "denied"   → user (or browser policy) refused — must be unblocked in
 *              site settings; re-prompting is impossible
 * "default"  → prompt couldn't be shown (e.g. iOS requires a fresh user
 *              gesture; the browser silenced it)
 */
export async function ensureNotificationPermission(): Promise<PushPermission> {
  if (!pushSupported()) return "unsupported";
  const perm = currentPermission();
  if (perm !== "default") return perm;
  try {
    // requestPermission() MUST be called before pushManager.subscribe() on
    // Firefox and iOS — Chrome tolerates the reverse order, others don't.
    const result = await Notification.requestPermission();
    return (result as PushPermission) ?? "default";
  } catch (e) {
    console.error("[push] requestPermission threw:", e);
    return "default";
  }
}

/* ------------------------------------------------------------------ */
/* VAPID key → applicationServerKey                                     */
/* ------------------------------------------------------------------ */

/** base64url → Uint8Array (accepted by every pushManager implementation). */
function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushState {
  supported: boolean;
  permission: PushPermission;
  /** true when THIS device has a live push subscription saved server-side. */
  subscribed: boolean;
}

/** Snapshot of this device's push readiness (never throws, never hangs). */
export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) {
    return { supported: false, permission: "unsupported", subscribed: false };
  }
  try {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    return {
      supported: true,
      permission: currentPermission(),
      subscribed: !!sub,
    };
  } catch {
    return { supported: true, permission: currentPermission(), subscribed: false };
  }
}

/* ------------------------------------------------------------------ */
/* The full enable flow                                                 */
/* ------------------------------------------------------------------ */

/**
 * Complete "turn on notifications for this device" flow:
 *   permission → SW register → SW ready → fetch VAPID key → subscribe →
 *   POST /api/notifications/subscribe.
 *
 * Call this from a user gesture (button click) whenever possible — some
 * browsers (iOS Safari) only show the permission prompt for calls made
 * directly inside a gesture handler.
 */
export async function ensurePushEnabled(): Promise<PushEnableResult> {
  if (!pushSupported()) {
    return {
      ok: false,
      stage: "unsupported",
      detail: "This browser doesn't support notifications.",
    };
  }

  // Already fully enabled on this device?
  const existing = await getPushState();
  if (existing.subscribed && currentPermission() === "granted") {
    return {
      ok: true,
      stage: "already-enabled",
      detail: "Notifications are already enabled on this device.",
    };
  }

  // 1. Permission — the PERMANENT browser-level prompt.
  const perm = await ensureNotificationPermission();
  if (perm === "denied") {
    return {
      ok: false,
      stage: "permission-denied",
      permission: perm,
      detail:
        "Notifications are blocked for this site. Unblock them in your browser's site settings (lock icon → Notifications → Allow), then try again.",
    };
  }
  if (perm !== "granted") {
    return {
      ok: false,
      stage: "permission-dismissed",
      permission: perm,
      detail:
        "The permission prompt couldn't be shown (or was dismissed). Tap the notification option again to retry.",
    };
  }

  // 2. Service worker — register (boot-safe) then wait for activation.
  await registerServiceWorker();
  const reg = await waitForServiceWorker();
  if (!reg) {
    return {
      ok: false,
      stage: "sw-ready",
      detail: "Notifications couldn't start on this device (service worker unavailable). Try reloading the page once.",
    };
  }

  // 3. Server's VAPID public key.
  let publicKey: string;
  try {
    const keyRes = await fetch("/api/notifications/vapid-public-key");
    const j = await keyRes.json().catch(() => ({}));
    if (!keyRes.ok || !j.publicKey) {
      return {
        ok: false,
        stage: "server-key",
        detail: j?.error ?? "Push isn't configured on this deployment yet.",
      };
    }
    publicKey = String(j.publicKey);
  } catch {
    return {
      ok: false,
      stage: "server-key",
      detail: "Couldn't reach the server for push setup — check your connection.",
    };
  }

  // 4. Subscribe (reuse an existing subscription when present).
  let sub: PushSubscription | null = null;
  try {
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
    }
  } catch (e: any) {
    console.error("[push] subscribe failed:", e);
    return {
      ok: false,
      stage: "subscribe",
      permission: "granted",
      detail:
        e?.name === "NotAllowedError"
          ? "The browser blocked the subscription — unblock notifications in site settings and retry."
          : `Couldn't subscribe this device: ${e?.message ?? e}`,
    };
  }

  // 5. Persist server-side.
  try {
    const payload = sub.toJSON();
    const res = await fetch("/api/notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return {
        ok: false,
        stage: "save",
        permission: "granted",
        detail: j?.error ?? "Couldn't save the subscription on the server.",
      };
    }
  } catch {
    return {
      ok: false,
      stage: "save",
      permission: "granted",
      detail: "Couldn't reach the server to finish enabling notifications.",
    };
  }

  return {
    ok: true,
    stage: "enabled",
    permission: "granted",
    detail: "Notifications enabled on this device 🔔",
  };
}

/* ------------------------------------------------------------------ */
/* V1.6 — Receipt echo, SW version probe, notification doctor, auto-heal */
/* ------------------------------------------------------------------ */

export interface PushReceipt {
  at: number;
  title: string;
  body: string;
  tag?: string | null;
  swVersion?: string;
}

function parseReceiptData(data: any): PushReceipt | null {
  if (!data || typeof data !== "object") return null;
  if (data.type !== "PUSH_RECEIVED") return null;
  return {
    at: Number(data.at) || 0,
    title: String(data.title ?? ""),
    body: String(data.body ?? ""),
    tag: data.tag ?? null,
    swVersion: typeof data.swVersion === "string" ? data.swVersion : undefined,
  };
}

/**
 * Which service-worker version is ACTUALLY active in this browser right now
 * (PONG reply to a PING postMessage). A tab that hasn't been reloaded since
 * a deploy keeps running the OLD worker — "the fix didn't work" was often
 * just "the fix isn't loaded yet". Returns null when no worker answers.
 */
export function pingServiceWorker(timeoutMs = 3000): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      resolve({ ok: false });
      return;
    }
    let done = false;
    const finish = (r: { ok: boolean; version?: string }) => {
      if (done) return;
      done = true;
      navigator.serviceWorker.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(r);
    };
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "PONG") finish({ ok: true, version: ev.data.version });
    };
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
    navigator.serviceWorker.addEventListener("message", onMsg);
    // Ask BOTH the controlling worker (normal case) and the registration's
    // active worker (first load, before the SW claims the page) to answer.
    try { navigator.serviceWorker.controller?.postMessage({ type: "PING" }); } catch { /* not controlled yet */ }
    navigator.serviceWorker.ready
      .then((reg) => { try { reg.active?.postMessage({ type: "PING" }); } catch { /* no active worker */ } })
      .catch(() => {});
  });
}

/**
 * Last push RECEIVED by this browser (read from the service worker's
 * persistent receipt cache — survives reloads). Null when none ever arrived
 * (or the cache is unavailable). This is the ground truth for "did the push
 * even reach this device" — completely independent of OS notification
 * settings, which is what makes the diagnosis airtight.
 */
export async function getLastPushReceipt(): Promise<PushReceipt | null> {
  if (typeof window === "undefined" || !("caches" in window)) return null;
  try {
    const cache = await caches.open("khata-push-log");
    const res = await cache.match("/__khata_push_receipt__");
    if (!res) return null;
    const j = await res.json().catch(() => null);
    return parseReceiptData(j);
  } catch {
    return null;
  }
}

/**
 * Wait up to `ms` for THIS browser to receive a push (the SW echoes
 * PUSH_RECEIVED the moment a push event fires). Resolves null on timeout.
 * Used right after "Send test" to tell, on THIS device, whether the push
 * arrived — separating "browser never got it" (different device / dead
 * subscription) from "browser got it but the OS hid it" (notification
 * settings / Focus / DND).
 */
export function waitForPushReceipt(ms = 15000): Promise<PushReceipt | null> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (r: PushReceipt | null) => {
      if (done) return;
      done = true;
      navigator.serviceWorker.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(r);
    };
    const onMsg = (ev: MessageEvent) => {
      const r = parseReceiptData(ev.data);
      if (r) finish(r);
    };
    const timer = setTimeout(() => finish(null), ms);
    navigator.serviceWorker.addEventListener("message", onMsg);
  });
}

/**
 * Continuous push-receipt listener — the in-page notification fallback.
 * While the app is open in this browser, every arriving push (test, reminder,
 * anything) also surfaces INSIDE the page as a toast/banner, so even a
 * device whose OS-level notifications are muted shows something visible.
 * Returns an unsubscribe function.
 */
export function listenForPushReceipts(cb: (r: PushReceipt) => void): () => void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const onMsg = (ev: MessageEvent) => {
    const r = parseReceiptData(ev.data);
    if (r) cb(r);
  };
  navigator.serviceWorker.addEventListener("message", onMsg);
  return () => navigator.serviceWorker.removeEventListener("message", onMsg);
}

/* ------------------------------------------------------------------ */
/* Notification doctor — a live, per-device checklist                     */
/* ------------------------------------------------------------------ */

export interface DoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "skip" | "info";
  detail: string;
  /** Concrete fix when the check isn't ok. */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  verdict: "healthy" | "needs-attention" | "broken";
  summary: string;
}

function platformLabel(): { browser: string; os: string; ios: boolean; standalone: boolean } {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const browser =
    /Edg\//i.test(ua) ? "Edge" :
    /OPR\//i.test(ua) ? "Opera" :
    /Firefox\//i.test(ua) ? "Firefox" :
    /Chrome\//i.test(ua) ? "Chrome" :
    /Safari\//i.test(ua) ? "Safari" : "this browser";
  const os =
    /Android/i.test(ua) ? "Android" :
    /iPhone|iPad|iPod/i.test(ua) ? "iOS" :
    /Windows/i.test(ua) ? "Windows" :
    /Mac OS X|Macintosh/i.test(ua) ? "macOS" :
    /Linux/i.test(ua) ? "Linux" : "this device";
  const standalone =
    (window.matchMedia?.("(display-mode: standalone)")?.matches ?? false) ||
    (navigator as any).standalone === true;
  return { browser, os, ios: os === "iOS", standalone };
}

function endpointProvider(endpoint: string): string {
  if (/fcm\.googleapis\.com/i.test(endpoint)) return "Chrome/Android push service (FCM)";
  if (/updates\.push\.services\.mozilla\.com/i.test(endpoint)) return "Firefox push service";
  if (/push\.apple\.com/i.test(endpoint)) return "Apple push service";
  return endpoint.replace(/^https?:\/\//, "").split("/")[0];
}

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Run the full on-device notification check. Every check returns a concrete,
 * user-actionable result — no more "it should work". Async-safe, never
 * throws; safe to call from any click handler.
 */
export async function runPushDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const plat = platformLabel();

  // 1. Capability
  if (!pushSupported()) {
    checks.push({
      id: "support",
      label: "Browser support",
      status: "fail",
      detail: "This browser doesn't support web push notifications.",
      fix: plat.ios && !plat.standalone
        ? "On iPhone/iPad, add Khata to your Home Screen first (Share → Add to Home Screen) — then notifications become available."
        : "Use Chrome, Edge, Firefox, or Safari 16.4+ for notifications.",
    });
    return { checks, verdict: "broken", summary: "Notifications can't work in this browser." };
  }
  checks.push({ id: "support", label: "Browser support", status: "ok", detail: `${plat.browser} on ${plat.os} supports web push.` });

  // 2. iOS install-state (the #1 iOS confusion — browser tab = no push)
  if (plat.ios) {
    if (plat.standalone) {
      checks.push({
        id: "ios-pwa",
        label: "Installed as an app",
        status: "ok",
        detail: "Running as an installed Home Screen app — required for iOS notifications.",
      });
    } else {
      checks.push({
        id: "ios-pwa",
        label: "Installed as an app",
        status: "fail",
        detail: "iOS only delivers web notifications to apps installed on the Home Screen — not to Safari tabs.",
        fix: "Tap Share → “Add to Home Screen”, open Khata from the icon, then enable notifications there.",
      });
    }
  }

  // 3. Permission
  const perm = currentPermission();
  if (perm === "granted") {
    checks.push({ id: "permission", label: "Permission", status: "ok", detail: "Notification permission is granted." });
  } else if (perm === "denied") {
    checks.push({
      id: "permission",
      label: "Permission",
      status: "fail",
      detail: "Notification permission is BLOCKED for this site.",
      fix: "Tap the lock/tune icon next to the address bar → Notifications → Allow, then reload and enable again.",
    });
  } else {
    checks.push({
      id: "permission",
      label: "Permission",
      status: "warn",
      detail: "Notification permission hasn't been granted yet.",
      fix: "Tap “Enable notifications” to grant it.",
    });
  }

  // 4. Service worker + version (stale-worker detection)
  const swReg = (await navigator.serviceWorker?.getRegistration?.("/").catch(() => null)) ?? null;
  if (!swReg) {
    checks.push({
      id: "sw",
      label: "Service worker",
      status: "fail",
      detail: "The notification service worker isn't registered in this browser.",
      fix: "Reload the page once, then tap Enable notifications.",
    });
  } else {
    const pong = await pingServiceWorker();
    if (pong.ok && pong.version) {
      checks.push({
        id: "sw",
        label: "Service worker",
        status: "ok",
        detail: `Active and answering (version ${pong.version}).`,
      });
    } else {
      checks.push({
        id: "sw",
        label: "Service worker",
        status: "warn",
        detail: "Registered but not answering — likely an old version still controlling this tab.",
        fix: "Close this tab fully and reopen Khata (or reload twice) so the new worker takes over.",
      });
    }
  }

  // 5. Local subscription
  const reg = swReg ?? (await navigator.serviceWorker.ready.catch(() => null));
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (!sub) {
    checks.push({
      id: "subscription",
      label: "This device's subscription",
      status: perm === "granted" ? "warn" : "skip",
      detail: perm === "granted"
        ? "Permission is granted but this browser hasn't subscribed for push yet."
        : "No push subscription (permission not granted yet).",
      fix: perm === "granted" ? "Tap “Enable notifications” to subscribe this device." : undefined,
    });
  } else {
    checks.push({
      id: "subscription",
      label: "This device's subscription",
      status: "ok",
      detail: `Subscribed via ${endpointProvider(sub.endpoint)}.`,
    });
  }

  // 6. VAPID key match — subscription made under DIFFERENT server keys is
  //    the classic silent killer after a redeploy with new keys.
  let serverKey: string | null = null;
  try {
    const r = await fetch("/api/notifications/vapid-public-key");
    const j = await r.json().catch(() => ({}));
    serverKey = r.ok && typeof j.publicKey === "string" ? j.publicKey : null;
  } catch { /* offline — skip */ }
  if (serverKey && sub) {
    let appKey: string | null = null;
    try {
      const opt = (sub as any).options?.applicationServerKey;
      if (opt instanceof ArrayBuffer) appKey = toBase64Url(opt);
      else if (typeof opt === "string") appKey = opt.replace(/=+$/, "");
    } catch { /* not exposed in this browser */ }
    if (appKey === null) {
      checks.push({
        id: "vapid",
        label: "Server key match",
        status: "skip",
        detail: "This browser doesn't expose the subscription's server key — can't verify automatically.",
      });
    } else if (appKey === serverKey.replace(/=+$/, "")) {
      checks.push({ id: "vapid", label: "Server key match", status: "ok", detail: "Subscription matches this deployment's push keys." });
    } else {
      checks.push({
        id: "vapid",
        label: "Server key match",
        status: "fail",
        detail: "This subscription was created under DIFFERENT push keys (keys changed on a redeploy). Pushes are accepted by the service but silently die at this browser.",
        fix: "Tap “Enable notifications” once — it re-subscribes under the current keys.",
      });
    }
  }

  // 7. Server-side registration (ghost detection) + auto-heal chance
  if (sub) {
    try {
      const r = await fetch("/api/notifications/test");
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const devices: any[] = Array.isArray(j.devices) ? j.devices : [];
        const known = devices.some((d) => typeof d.endpointTail === "string" && sub.endpoint.endsWith(d.endpointTail));
        if (known) {
          checks.push({ id: "server", label: "Server knows this device", status: "ok", detail: `Saved on the server${devices.length > 1 ? ` (${devices.length} devices registered)` : ""}.` });
        } else {
          const healed = await resubscribeIfNeeded();
          checks.push({
            id: "server",
            label: "Server knows this device",
            status: healed ? "warn" : "fail",
            detail: healed
              ? "This browser's subscription wasn't saved server-side — it has been re-saved automatically now."
              : "This browser's subscription is NOT saved on the server — pushes go to other devices only.",
            fix: healed ? undefined : "Tap “Enable notifications” to re-save this device.",
          });
        }
      }
    } catch { /* offline — skip */ }
  }

  // 8. Last receipt — proof of actual delivery to THIS browser
  const receipt = await getLastPushReceipt();
  if (receipt?.at) {
    const when = new Date(receipt.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    checks.push({
      id: "receipt",
      label: "Last push received",
      status: "info",
      detail: `A push reached this browser at ${when}${receipt.title ? ` — “${receipt.title}”` : ""}. If you didn't SEE it, the block is at the OS level (notification settings / Focus / DND), not in the app.`,
      fix: plat.os === "Windows"
        ? "Check Windows Settings → System → Notifications (Chrome must be allowed) and Focus Assist."
        : plat.os === "Android"
          ? "Check Android Settings → Apps → Chrome → Notifications, and that Do Not Disturb isn't hiding banners (they land in the shade — swipe down)."
          : plat.os === "iOS"
            ? "Check iOS Settings → Notifications → Khata (the Home Screen app) — banners and sounds must be on."
            : plat.os === "macOS"
              ? "Check macOS System Settings → Notifications → the browser — and Focus/Do Not Disturb."
              : "Check the OS notification settings for this browser.",
    });
  } else if (sub) {
    checks.push({
      id: "receipt",
      label: "Last push received",
      status: "skip",
      detail: "No push has arrived in this browser yet (nothing recorded). Send a test to create the first receipt.",
    });
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  const verdict = hasFail ? "broken" : hasWarn ? "needs-attention" : "healthy";
  const failCount = checks.filter((c) => c.status === "fail").length;
  const summary = hasFail
    ? `${failCount} problem${failCount === 1 ? "" : "s"} found — see the fix steps above.`
    : hasWarn
      ? "Nearly there — a couple of things need attention."
      : "Everything checks out — notifications are fully set up on this device.";
  return { checks, verdict, summary };
}

/**
 * Silent boot-time auto-heal for THIS device's push subscription:
 *  - permission granted + no local subscription → subscribe + save;
 *  - local subscription not saved server-side (DB reset, save failed) → re-save;
 *  - subscription keys mismatch the server's current VAPID key → resubscribe
 *    under the new key + save (the post-redeploy silent-death case).
 * Never prompts (permission must already be granted), never throws, throttled
 * to one attempt per page load.
 */
let _resubscribeAttempted = false;
export async function resubscribeIfNeeded(): Promise<boolean> {
  if (_resubscribeAttempted) return false;
  _resubscribeAttempted = true;
  if (!pushSupported() || currentPermission() !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg) return false;

    let sub = await reg.pushManager.getSubscription().catch(() => null);

    // Server's current VAPID key + saved devices.
    let serverKey: string | null = null;
    let savedTails: string[] = [];
    try {
      const kr = await fetch("/api/notifications/vapid-public-key");
      const kj = await kr.json().catch(() => ({}));
      serverKey = kr.ok && typeof kj.publicKey === "string" ? kj.publicKey : null;
    } catch { /* offline — can't heal */ }
    try {
      const dr = await fetch("/api/notifications/test");
      if (dr.ok) {
        const dj = await dr.json().catch(() => ({}));
        savedTails = (Array.isArray(dj.devices) ? dj.devices : [])
          .map((d: any) => (typeof d.endpointTail === "string" ? d.endpointTail : ""))
          .filter(Boolean);
      }
    } catch { /* offline — can't heal the ghost case */ }

    // Key mismatch? → the old subscription is dead weight; drop it.
    let keyMismatch = false;
    if (sub && serverKey) {
      try {
        const opt = (sub as any).options?.applicationServerKey;
        const appKey = opt instanceof ArrayBuffer ? toBase64Url(opt) : typeof opt === "string" ? opt.replace(/=+$/, "") : null;
        if (appKey && appKey !== serverKey.replace(/=+$/, "")) keyMismatch = true;
      } catch { /* not exposed — treat as unknown */ }
    }

    if (keyMismatch && sub) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }

    const savedHere = !!sub && savedTails.some((tail) => sub!.endpoint.endsWith(tail));
    if (sub && savedHere && !keyMismatch) return false; // healthy — nothing to do

    // (Re)subscribe under the CURRENT server key.
    if (!sub) {
      if (!serverKey) return false;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(serverKey) as unknown as BufferSource,
      });
    }

    // Persist.
    const res = await fetch("/api/notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(sub.toJSON()),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Test notification                                                    */
/* ------------------------------------------------------------------ */

export interface TestPushResult {
  ok: boolean;
  sent: number;
  failed: number;
  /** First failure reason (from the push service), when any. */
  error?: string;
  httpError?: string;
  /** Devices (browser + OS) the test targeted — V1.5. */
  devices?: { id: string; label: string; endpointTail: string; subscribedAt: string | null }[];
  /** The server's current VAPID public key — V1.6 (client-side key match). */
  vapidPublicKey?: string;
  /** Server clock at send — V1.6 (receipt latency measurement). */
  sentAt?: number;
}

/** POST /api/notifications/test and report the TRUTH. */
export async function sendTestPush(message?: string): Promise<TestPushResult> {
  try {
    const res = await fetch("/api/notifications/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message ?? "Test notification" }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, sent: 0, failed: 0, httpError: j?.error ?? `HTTP ${res.status}` };
    }
    return {
      ok: true,
      sent: Number(j.sent ?? 0),
      failed: Number(j.failed ?? 0),
      error: typeof j.error === "string" ? j.error : undefined,
      devices: Array.isArray(j.devices) ? j.devices : [],
      vapidPublicKey: typeof j.vapidPublicKey === "string" ? j.vapidPublicKey : undefined,
      sentAt: typeof j.sentAt === "number" ? j.sentAt : undefined,
    };
  } catch (e: any) {
    return { ok: false, sent: 0, failed: 0, httpError: e?.message ?? "network error" };
  }
}

function ageOf(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Turn a TestPushResult into honest user-facing text. V1.5: says WHICH
 * device(s) were targeted (browser + OS + how old the subscription is) and,
 * when a push was accepted but nothing showed, names the two usual OS-level
 * suspects (Focus Assist / notification-center mute) instead of shrugging.
 */
export function describeTestResult(r: TestPushResult): { kind: "ok" | "warn" | "error"; text: string } {
  if (!r.ok) {
    return {
      kind: "error",
      text: r.httpError ?? "Couldn't send the test notification.",
    };
  }
  const deviceText = (r.devices ?? [])
    .map((d) => `${d.label}${ageOf(d.subscribedAt) ? ` · subscribed ${ageOf(d.subscribedAt)}` : ""}`)
    .join(", ");
  if (r.sent > 0 && r.failed === 0) {
    return {
      kind: "ok",
      text:
        `Sent to ${r.sent} device${r.sent === 1 ? "" : "s"}${deviceText ? ` (${deviceText})` : ""} — ` +
        `it stays on screen until dismissed. If nothing appears: check the notification center / ` +
        `Focus Assist (Windows) or Do Not Disturb, and that the target browser is running.`,
    };
  }
  if (r.sent > 0 && r.failed > 0) {
    return {
      kind: "warn",
      text: `Sent to ${r.sent} device${r.sent === 1 ? "" : "s"}${deviceText ? ` (${deviceText})` : ""}, but ${r.failed} subscription${r.failed === 1 ? "" : "s"} failed${r.failed === 1 ? "" : "s"}${r.error ? ` (${r.error})` : ""}.`,
    };
  }
  return {
    kind: "warn",
    text:
      "No device is subscribed for notifications yet — tap \"Enable notifications\" first, then test again.",
  };
}
