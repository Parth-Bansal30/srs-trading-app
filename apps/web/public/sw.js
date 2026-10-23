// Helps the installed app open without internet (23 Oct 2026). App files come from the internet first and
// from the copy kept here when the internet is not there (or too slow). The app's main files are kept at
// install, so it opens offline even the first time after installing. Shop data (Supabase) is never kept here —
// the app keeps its own copy for the person who is signed in (lib/offline).
const CACHE = 'app-v3';
const SLOW_MS = 4000;   // a weak signal: after this, a page opens from the kept copy

async function keepAppFiles() {
  try {
    const c = await caches.open(CACHE);
    const res = await fetch('./', { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.clone().text();
    await c.put('./', res);
    const urls = [...new Set([...html.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css|webmanifest|png|svg|woff2?))"/g)].map((m) => m[1]))];
    await Promise.all(urls.map((u) => fetch(u).then((r) => (r.ok ? c.put(u, r) : null)).catch(() => null)));
  } catch { /* offline while installing: the files are kept as they are used */ }
}
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(keepAppFiles()); });
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));

const fromCopy = (req) => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') : null));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const net = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; });
  if (req.mode === 'navigate') {
    // the page itself: don't wait long on a weak signal
    e.respondWith(new Promise((ok) => {
      let done = false;
      const timer = setTimeout(() => fromCopy(req).then((hit) => { if (hit && !done) { done = true; ok(hit); } }), SLOW_MS);
      net.then((res) => { if (!done) { done = true; clearTimeout(timer); ok(res); } })
        .catch(() => fromCopy(req).then((hit) => { if (!done) { done = true; clearTimeout(timer); ok(hit || Response.error()); } }));
    }));
    return;
  }
  e.respondWith(net.catch(() => fromCopy(req).then((hit) => hit || Response.error())));
});

// Evening summary (and later other messages): show the notification; a tap opens that screen in the app.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'SRS Trading', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: d.url || '#/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '#/', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    if (open) return open.focus().then((c) => (c && c.navigate ? c.navigate(url) : c));
    return self.clients.openWindow(url);
  }));
});
