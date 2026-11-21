// Every URL is derived from the registration scope, so this file works at the origin root ('/') and
// under a project subpath such as /stresspulse-app/ on GitHub Pages, where other sites share the
// <user>.github.io origin and its Cache Storage. Bump the version for breaking shell changes.
const SCOPE = self.registration.scope; // e.g. https://<user>.github.io/stresspulse-app/
const SCOPE_PATH = new URL(SCOPE).pathname;
const CACHE_PREFIX = 'stresspulse:' + SCOPE_PATH + ':';
const CACHE = CACHE_PREFIX + 'v3';
const SHELL = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'].map((path) => new URL(path, SCOPE).href);

const inScope = (url) => url.startsWith(SCOPE);
const isShell = (url) => {
  const { origin, pathname } = new URL(url);
  return origin + pathname === SCOPE || origin + pathname === SCOPE + 'index.html';
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // The first visit is not controlled by the worker yet, so also precache the hashed JS/CSS and
      // icons the shell references: the app then opens offline after a single online visit.
      const html = await (await cache.match(SCOPE)).text();
      const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => new URL(match[1], SCOPE).href);
      const extra = [...new Set(refs)].filter((url) => inScope(url) && !SHELL.includes(url));
      await Promise.all(extra.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete only this scope's outdated caches; other apps on a shared origin keep theirs. The
      // unscoped 'stresspulse-v1'/'-v2' caches came from the old worker, which only ran at '/'.
      const keys = await caches.keys();
      const stale = keys.filter(
        (key) => (key.startsWith(CACHE_PREFIX) && key !== CACHE) || (SCOPE_PATH === '/' && /^stresspulse-v\d+$/.test(key)),
      );
      await Promise.all(stale.map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !inScope(req.url)) return;
  event.respondWith(req.mode === 'navigate' ? navigate(event) : cacheFirst(event));
});

// Navigations are network-first so a new deploy is picked up on the next online load. Only a 200 for
// the shell itself (scope root or index.html) refreshes the cached copy, never a 404 page; while
// offline, every navigation inside the scope falls back to that shell.
async function navigate(event) {
  try {
    const res = await fetch(event.request);
    if (res.status === 200 && isShell(event.request.url)) stash(event, SCOPE, res.clone());
    return res;
  } catch (error) {
    const shell = await caches.open(CACHE).then((cache) => cache.match(SCOPE));
    if (!shell) throw error;
    // A redirected response cannot answer a navigation request; serve a clean copy instead.
    return shell.redirected
      ? new Response(shell.body, { status: shell.status, statusText: shell.statusText, headers: shell.headers })
      : shell;
  }
}

// Everything else in the scope is cache-first: hashed bundles change name on every build, and the few
// unhashed files (manifest, icons) change with a CACHE bump. An offline miss stays a network error
// rather than an HTML page standing in for a script or an image.
async function cacheFirst(event) {
  const cached = await caches.open(CACHE).then((cache) => cache.match(event.request));
  if (cached) return cached;
  const res = await fetch(event.request);
  if (res.status === 200 && res.type === 'basic') stash(event, event.request, res.clone());
  return res;
}

// Cache in the background and keep the worker alive until the write has finished.
function stash(event, key, response) {
  const write = caches.open(CACHE).then((cache) => cache.put(key, response)).catch(() => {});
  try {
    event.waitUntil(write);
  } catch {
    // The event's lifetime already ended; the write still completes while the worker runs.
  }
}
