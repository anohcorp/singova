const CACHE = 'singova-v3';  // bump version when any static asset changes
const STATIC = [
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/service-worker.js',
];

// Install — pre-cache static shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

// Activate — purge old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch — pass cross-origin requests (e.g. Render API) straight to network;
//          network-first for same-origin /transcribe and /health;
//          cache-first for all other static assets.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── 1. Cross-origin (e.g. https://singova.onrender.com) → always network ──
  if (url.origin !== self.location.origin) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // ── 2. Same-origin API routes → network-first, never cached ──────────────
  if (url.pathname === '/transcribe' || url.pathname === '/health' || url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // ── 3. Static assets → cache-first, update in background ─────────────────
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      });
      return cached || network;
    })
  );
});
