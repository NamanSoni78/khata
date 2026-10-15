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
/* Test notification                                                    */
/* ------------------------------------------------------------------ */

export interface TestPushResult {
  ok: boolean;
  sent: number;
  failed: number;
  /** First failure reason (from the push service), when any. */
  error?: string;
  httpError?: string;
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
    };
  } catch (e: any) {
    return { ok: false, sent: 0, failed: 0, httpError: e?.message ?? "network error" };
  }
}

/**
 * Turn a TestPushResult into honest user-facing text. The old UI said
 * "Sent! Check your notifications" even when sent === 0 — which is how
 * "test notification not working" went undiagnosed for so long.
 */
export function describeTestResult(r: TestPushResult): { kind: "ok" | "warn" | "error"; text: string } {
  if (!r.ok) {
    return {
      kind: "error",
      text: r.httpError ?? "Couldn't send the test notification.",
    };
  }
  if (r.sent > 0 && r.failed === 0) {
    return { kind: "ok", text: `Sent to ${r.sent} device${r.sent === 1 ? "" : "s"} — check your notifications.` };
  }
  if (r.sent > 0 && r.failed > 0) {
    return {
      kind: "warn",
      text: `Sent to ${r.sent} device${r.sent === 1 ? "" : "s"}, but ${r.failed} subscription${r.failed === 1 ? "" : "s"} failed${r.failed === 1 ? "" : "s"}${r.error ? ` (${r.error})` : ""}.`,
    };
  }
  return {
    kind: "warn",
    text:
      "No device is subscribed for notifications yet — tap \"Enable notifications\" first, then test again.",
  };
}
