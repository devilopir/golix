const CACHE = 'golix';
const MAX_ASSETS = 30;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function trimAssets(cache) {
  const keys = (await cache.keys()).filter((req) => new URL(req.url).pathname.startsWith('/assets/'));
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((req) => cache.delete(req)));
}

// Build assets have hashed names and never change; pages are always fetched fresh and only served from cache offline.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        if (res.ok) await cache.put(request, res.clone()).then(() => trimAssets(cache));
        return res;
      }),
    );
  } else if (request.mode === 'navigate' && !url.pathname.startsWith('/headless/') && !url.pathname.startsWith('/docs/') && !url.pathname.startsWith('/headlesstoken/')) {
    event.respondWith(
      fetch(request)
        .then(async (res) => {
          if (res.ok) await (await caches.open(CACHE)).put('/', res.clone());
          return res;
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    );
  }
});
