// Offline obal appky: súbory appky z cache, dáta vždy zo servera (sklad musí byť aktuálny).
const VERZIA = "logiq-sklad-6";
const SUBORY = ["./", "index.html", "styles.css", "app.js", "api.js", "scanner.js", "config.js", "ikona.svg", "ikona-192.png", "manifest.webmanifest"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(VERZIA).then((c) => c.addAll(SUBORY)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== VERZIA).map((x) => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // Supabase a CDN idú vždy na sieť
  e.respondWith(fetch(e.request).then((r) => { const kopia = r.clone(); caches.open(VERZIA).then((c) => c.put(e.request, kopia)); return r; })
    .catch(() => caches.match(e.request).then((r) => r ?? caches.match("index.html"))));
});
