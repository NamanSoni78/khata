// Khata PWA Service Worker — offline shell + push + background sync
// - Caches app shell for offline fallback (cache-first on / route)
// - Listens for push events (Phase 3 will activate the displayNotification)
// - Listens for "sync" event (Phase 3 will flush queued messages via Background Sync API)

const CACHE_NAME = "khata-v3";
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
    // Stale-while-revalidate for app shell
    e.respondWith(
      (async () => {
        const cached = await caches.match(e.request);
        const fetchPromise = fetch(e.request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
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
//  PUSH NOTIFICATIONS (Phase 3 will fully wire this up)
// ============================================================

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "Khata", body: e.data?.text() ?? "" };
  }
  const title = data.title ?? "Khata";
  const options = {
    body: data.body ?? data.message ?? "",
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    data: { url: data.url ?? "/" },
    vibrate: [200, 80, 200],
    requireInteraction: false,
    actions: [{ action: "open", title: "Open" }],
    tag: data.tag ?? "khata-notif",
    renotify: !!data.tag,
  };
  e.waitUntil(self.registration.showNotification(title, options));
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
