// Khata PWA Service Worker — offline shell + push (WhatsApp-style v5)
// - Caches app shell for offline fallback (cache-first on / route)
// - Listens for push events and shows notifications that can't be missed
// - Listens for "sync" event to flush queued messages via Background Sync API

// v8 — "never-invisible notifications":
//   The V1.5 mystery was pushes accepted by the push service ("Sent to 1
//   device") yet nothing on screen, with NO way to tell where the chain
//   broke. v8 makes every push RECEIPT OBSERVABLE and every display
//   failure survivable:
//   1. ECHO FIRST — every push receipt is postMessage'd to ALL open tabs
//      (PUSH_RECEIVED) BEFORE any display attempt, so the app can show an
//      in-page toast even when the OS silences the banner.
//   2. PERSISTENT RECEIPT LOG — the receipt is also written to a dedicated
//      Cache (survives reloads): the page reads it on boot ("last push
//      received by this browser: 18:18"), and the notification doctor uses
//      it to prove delivery independently of OS notification settings.
//   3. PING/PONG — the page asks "which version are you?" so a stale worker
//      (still v7 because the tab never reloaded) is DETECTABLE instead of
//      mysterious.
//   4. 3-LEVEL DISPLAY CASCADE — full options → minimal options → bare
//      {body}. A notification can no longer die because one browser
//      rejected one option.
//   5. pushsubscriptionchange — the browser rotated/invalidated the push
//      subscription → resubscribe with the server's current VAPID key and
//      re-save it (session cookies ride along — same-origin SW fetch).
// v7: notification display fixes — no more SILENT same-tag replacement
//   (every push used tag "khata-notif" + renotify:false, so consecutive
//   notifications silently swapped on Android/desktop instead of alerting).

// NOTE: classic service-worker script — no `export` statements allowed.
const KHATA_SW_VERSION = "v8";

const CACHE_NAME = "khata-v8";
const PUSH_LOG_CACHE = "khata-push-log";
const PUSH_LOG_URL = "/__khata_push_receipt__";
const APP_SHELL = [
  "/",
  "/manifest.json",
  "/icon-192.svg",
  "/icon-512.svg",
  "/icon-maskable.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== PUSH_LOG_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GET requests
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // API calls: don't cache — just attempt the network (will fail when offline)
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } })));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/admin") {
    // Network-first for HTML: the page is server-rendered with the user's auth
    // stage (login / unlock / chat), so a stale cached page can show the login
    // screen even when the session cookie is valid. Cache is only an offline fallback.
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(e.request);
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          return res;
        } catch {
          const cached = await caches.match(e.request);
          return cached || Response.error();
        }
      })()
    );
    return;
  }
  // Static assets: cache-first
  e.respondWith(
    (async () => {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      const res = await fetch(e.request);
      const clone = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
      return res;
    })()
  );
});

// ============================================================
//  PUSH NOTIFICATIONS — v8: echo → log → display (never silent)
// ============================================================

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "Khata", body: e.data?.text() ?? "" };
  }
  const title = data.title ?? "Khata";
  const body = data.body ?? data.message ?? "You have a new reminder — tap to open.";
  const at = Date.now();

  // (1) ECHO FIRST — tell every open tab BEFORE attempting to display, so a
  // display failure (OS-level mute, option rejection) still leaves a visible
  // trace in the app UI. includeUncontrolled so not-yet-controlled pages
  // (fresh reload) also hear it.
  // (2) PERSISTENT RECEIPT — write to a Cache so the NEXT page load can also
  // see when the last push actually ARRIVED in this browser.
  // (3) DISPLAY — full options → minimal options → bare body. Never throws.
  e.waitUntil(
    (async () => {
      const echo = { type: "PUSH_RECEIVED", at, title, body, tag: data.tag ?? null, swVersion: KHATA_SW_VERSION };
      try {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of clients) {
          try { c.postMessage(echo); } catch { /* one dead client must not kill the rest */ }
        }
      } catch { /* echo is best-effort */ }
      try {
        const cache = await caches.open(PUSH_LOG_CACHE);
        await cache.put(
          PUSH_LOG_URL,
          new Response(JSON.stringify(echo), { headers: { "Content-Type": "application/json" } })
        );
      } catch { /* receipt log is best-effort */ }

      // V1.5 display rules (kept):
      //  - tag is set ONLY when the payload carries one (tests send a unique
      //    per-send tag; reminders send none → every reminder alerts fresh).
      //  - whenever a tag IS set, renotify:true — tagged notifications
      //    re-alert instead of silently replacing their predecessor.
      //  - requireInteraction passes through (tests keep themselves on screen
      //    until dismissed — impossible to miss).
      const options = {
        body,
        icon: "/icon-192.png",
        badge: "/icon-maskable-512.png",
        data: { url: data.url ?? "/" },
        vibrate: [200, 80, 200],
        requireInteraction: !!data.requireInteraction,
        actions: [{ action: "open", title: "Open" }],
      };
      if (data.tag) {
        options.tag = data.tag;
        options.renotify = true;
      }
      try {
        await self.registration.showNotification(title, options);
      } catch (err1) {
        // Level 2: some platforms reject parts of the options (e.g. actions
        // on old Android WebView) — retry with a minimal set.
        console.error("[sw] showNotification failed, retrying minimal:", err1);
        try {
          await self.registration.showNotification(title, {
            body,
            icon: "/icon-192.png",
            data: options.data,
          });
        } catch (err2) {
          // Level 3: absolute fallback — bare text. The ONLY way a push can
          // end up invisible after this is an OS/browser-level notification
          // block, which the receipt echo above already exposed.
          console.error("[sw] minimal showNotification failed, retrying bare:", err2);
          try {
            await self.registration.showNotification(title, { body });
          } catch (err3) {
            console.error("[sw] showNotification fully failed (OS-level block?):", err3);
          }
        }
      }
    })()
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url ?? "/";
  // Handle action buttons
  if (e.action === "dismiss") return;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      // Prefer the window whose pathname matches the notification's url
      // (the old `c.url.includes(url)` matched "/" against EVERY window and
      // always focused an arbitrary one).
      let target = null;
      let any = null;
      for (const c of clientsArr) {
        if (!any) any = c;
        try {
          if (new URL(c.url).pathname === url) { target = c; break; }
        } catch { /* unparseable client url — skip */ }
      }
      const win = target ?? any;
      if (win && "focus" in win) return win.focus();
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// ============================================================
//  SUBSCRIPTION ROTATION — the browser invalidated/changed the push
//  subscription (Firefox rotates regularly; Chrome occasionally). Without
//  this, every future send targets a dead endpoint while the server still
//  believes the old one — the push service keeps answering 201 until it
//  decides the endpoint is stale, i.e. INVISIBLE failure.
// ============================================================

self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    (async () => {
      try {
        // Fetch the server's CURRENT VAPID public key (same-origin; session
        // cookies are attached automatically for same-origin SW fetches).
        const keyRes = await fetch("/api/notifications/vapid-public-key");
        const j = await keyRes.json().catch(() => ({}));
        if (!keyRes.ok || !j.publicKey) return;
        const applicationServerKey = urlB64ToUint8Array(String(j.publicKey));
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        await fetch("/api/notifications/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(sub.toJSON()),
        });
      } catch (err) {
        console.error("[sw] pushsubscriptionchange resubscribe failed:", err);
      }
    })()
  );
});

/** base64url → Uint8Array (mirrors the client helper). */
function urlB64ToUint8Array(base64url) {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ============================================================
//  PAGE ↔ SW MESSAGES — PING/PONG (version probe) + SKIP_WAITING
// ============================================================

self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (e.data?.type === "PING") {
    e.source?.postMessage({ type: "PONG", version: KHATA_SW_VERSION });
  }
});

// ============================================================
//  BACKGROUND SYNC (Phase 3 will use this for queued messages)
// ============================================================

self.addEventListener("sync", (e) => {
  if (e.tag === "khata-queue") {
    e.waitUntil(
      self.clients.matchAll().then((clientsArr) =>
        clientsArr.forEach((c) => c.postMessage({ type: "SYNC_TRIGGER" }))
      )
    );
  }
});
