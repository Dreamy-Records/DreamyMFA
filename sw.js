const CACHE_NAME = "dreamy-mfa-v5";
const APP_SHELL = [
  "/index.html",
  "/styles.css",
  "/app.js",
  "/dist/authenticator.bundle.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === "CACHE_APP_SHELL") {
    event.waitUntil(cacheAppShell());
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== "GET") return;

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/logout") {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (isCacheableAppResponse(response)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          }
          return response;
        })
        .catch(() => cachedIndexResponse()),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (isCacheableAppResponse(response)) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    }),
  );
});

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    APP_SHELL.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
        if (isCacheableAppResponse(response)) await cache.put(url, response);
      } catch (error) {
        // A failed optional asset should not prevent the service worker from installing.
      }
    }),
  );
}

function isCacheableAppResponse(response) {
  return response.ok && response.type === "basic" && !response.redirected;
}

async function cachedIndexResponse() {
  const cached = await caches.match("/index.html");
  if (cached) return cached;

  return new Response(
    `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Dreamy MFA</title>
  </head>
  <body>
    <main style="font-family: system-ui, sans-serif; padding: 24px;">
      <h1>Dreamy MFA</h1>
      <p>オフライン用データがまだ準備できていません。オンラインで一度開き直してください。</p>
    </main>
  </body>
</html>`,
    {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}
