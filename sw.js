// Service worker: network-first for the app shell so the newest code always wins
// when online, with a cached copy as offline fallback.
// Bump together with APP_VERSION in js/app.js (shown in Settings).
const CACHE = "korean-srs-v10";
const ASSETS = [
  ".",
  "index.html",
  "css/styles.css",
  "js/app.js",
  "js/db.js",
  "js/srs.js",
  "js/seed.js",
  "manifest.webmanifest",
  "icon.svg",
];

// Precache with `cache: "reload"` so install bypasses the HTTP cache and never
// stores a stale asset (the bug that pinned old code under a fresh cache name).
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((u) =>
        fetch(new Request(u, { cache: "reload" }))
          .then((r) => (r.ok ? c.put(u, r) : null))
          .catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for same-origin GETs: try the network (newest code), fall back to
// cache when offline. Cross-origin requests go straight to the network untouched.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
  );
});
