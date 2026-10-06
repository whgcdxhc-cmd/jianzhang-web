const CACHE = "jianzhang-0.4.0-independent-cloud";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./parser.js",
  "./importers.js",
  "./storage.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/api/cloud/") ||
      url.pathname.startsWith("/api/auth/"))
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((response) => {
            if (response.ok && url.origin === self.location.origin) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => caches.match("./index.html")),
    ),
  );
});
