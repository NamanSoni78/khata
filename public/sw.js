// Khata PWA Service Worker — offline shell + push (WhatsApp-style v5)
// - Caches app shell for offline fallback (cache-first on / route)
// - Listens for push events and shows notifications that can't be missed
// - Listens for "sync" event to flush queued messages via Background Sync API

// v7: notification display fixes — no more SILENT same-tag replacement
// (every push used tag "khata-notif" + renotify:false, so consecutive
// notifications silently swapped on Android/desktop instead of alerting).
const CACHE_NAME = "khata-v7";
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GET requests
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-first for API + HTML pages; cache-first for static assets
  if (url.pathname.startsWith("/api/")) {
    // API calls: don't cache — just attempt the network (will fail when offline)
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
//  PUSH NOTIFICATIONS
// ============================================================

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "Khata", body: e.data?.text() ?? "" };
  }
  const title = data.title ?? "Khata";
  // V1.5 display rules:
  //  - tag is set ONLY when the payload carries one (tests send a unique
  //    per-send tag; reminders send none → every reminder alerts fresh).
  //  - whenever a tag IS set, renotify:true — tagged notifications
  //    re-alert instead of silently replacing their predecessor.
  //  - requireInteraction passes through (tests keep themselves on screen
  //    until dismissed — impossible to miss).
  const options = {
    body: data.body ?? data.message ?? "",
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
  e.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(title, options);
      } catch (err) {
        // Some platforms reject parts of the options (e.g. actions on old
        // Android WebView) — retry with a minimal set so the notification
        // STILL shows instead of vanishing.
        console.error("[sw] showNotification failed, retrying minimal:", err);
        await self.registration.showNotification(title, {
          body: options.body,
          icon: "/icon-192.png",
          data: options.data,
        });
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
    self.clients.matchAll({ type: "window" }).then((clientsArr) => {
      for (const c of clientsArr) {
        if (c.url.includes(url) && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// ============================================================
//  PUSH SUBSCRIPTION helper (client calls this via postMessage to register SW)
// ============================================================

self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
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
