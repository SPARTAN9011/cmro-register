// network-first for our own files so code updates always reach the phone;
// the database (Supabase) and CDNs go straight to the network.
const CACHE = "cmro-register-v2";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./config.js",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./hero.webp"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;      // Supabase / CDNs -> network
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))              // offline fallback
  );
});
