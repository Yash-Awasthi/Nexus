/**
 * Judica PWA Service Worker — Phase 3.15
 *
 * Strategy:
 *  - App shell (HTML, CSS, JS): StaleWhileRevalidate
 *  - API calls (/api/*): NetworkOnly (never cache auth/live data)
 *  - Static assets (icons, fonts): CacheFirst with 30-day TTL
 *
 * Cache names are versioned — bump CACHE_VERSION on deploy to purge stale caches.
 */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `judica-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `judica-static-${CACHE_VERSION}`;

const SHELL_URLS = ["/", "/dashboard", "/chat", "/manifest.json", "/favicon.svg"];

// Dev guard — the shell cache is a production artifact. Vite dev serves
// transformed modules under content-hashed, server-invalidated URLs
// (/node_modules/.vite/deps/*?v=…, /app/routes/*.tsx); caching them means a
// re-optimization strands pages on the OLD hashed chunk alongside the new
// one — two React copies, "Cannot read properties of null (reading
// 'useContext')". Observed repeatedly in dev playtests. In dev this SW
// unregisters itself, clears its caches, and never intercepts fetches.
const IS_DEV = self.location.hostname === "localhost" || self.location.hostname === "127.0.0.1";

// ── Install ───────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  if (IS_DEV) {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.registration.unregister())
        .catch(() => {}),
    );
    return;
  }
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_URLS).catch(() => {
        // Non-fatal: some shell URLs may 404 during dev
      }),
    ),
  );
  // Take control immediately — no need to wait for old SW to unload
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  if (IS_DEV) {
    self.clients.claim();
    return;
  }
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE && k !== STATIC_CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  if (IS_DEV) return; // never serve dev artifacts from cache — see IS_DEV above
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // API calls — always network, never cache
  if (url.pathname.startsWith("/api/")) return;

  // Static assets (fonts, icons, images) — CacheFirst
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // App shell — StaleWhileRevalidate
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

// ── Strategies ───────────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);

  return cached ?? fetchPromise;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/fonts/") ||
    pathname.startsWith("/icons/") ||
    /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)$/.test(pathname)
  );
}

// ── Push notifications (stub) ─────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Judica", {
      body: data.body ?? "",
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: { url: data.url ?? "/dashboard" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/dashboard";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((c) => c.url.includes(url));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    }),
  );
});
