/* Self-updating service worker.

   No version number to bump. The app opens instantly from the cache, then the
   page sends "check": every shell file is re-fetched past the HTTP cache, the
   cache is refreshed, and if index.html or app.js came back different every
   open window is sent "updated" so it can show its "new version" bar. */
"use strict";

const CACHE_PREFIX = "tsod-";       // unique to THIS app — see activate
const CACHE = "tsod-shell";         // fixed name; never changes between deploys
const INDEX = "./index.html";
// The code pair. They are only ever stored together, so a half-finished
// refresh can never leave a new index.html running against an old app.js.
const CORE = [INDEX, "./app.js"];
const SHELL = CORE.concat([
  "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-180.png",
  "./icon-maskable-512.png", "./favicon-32.png"
]);

function sameBytes(a, b){
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// Fetch one file past the HTTP cache. Errors and non-200 responses resolve to
// null, so a 404/503 from the host can never replace the app.
function grab(url){
  return fetch(url, { cache: "no-cache" })
    .then(res => (res && res.ok) ? res.arrayBuffer().then(buf => ({ url, res: new Response(buf, { status: 200, headers: res.headers }), buf })) : null)
    .catch(() => null);
}

// Store a fetched file. Resolves true only when a copy was already cached and
// the new one differs.
function store(c, got){
  return c.match(got.url)
    .then(old => old ? old.arrayBuffer() : null)
    .then(prev => c.put(got.url, got.res).then(() => !!prev && !sameBytes(prev, got.buf)));
}

// Refresh every shell file. Resolves true when the app code changed.
function refreshShell(){
  return Promise.all(SHELL.map(grab)).then(all => {
    const core = all.slice(0, CORE.length), rest = all.slice(CORE.length).filter(Boolean);
    const coreOk = core.every(Boolean);
    return caches.open(CACHE).then(c =>
      Promise.all([
        coreOk ? Promise.all(core.map(g => store(c, g))) : [],
        Promise.all(rest.map(g => store(c, g)))
      ]).then(r => r[0].some(Boolean))
    );
  }).catch(() => false);
}

// install: precache, then take over at once. Safe because the cache name is
// stable — a new worker never strands an open page on a deleted cache.
self.addEventListener("install", e => {
  e.waitUntil(refreshShell().then(() => self.skipWaiting()));
});

// activate: delete only THIS app's other caches (the old versioned ones).
// Cache Storage is shared by the whole origin — on <user>.github.io that is
// every project page — so never delete caches without our prefix.
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE) ? caches.delete(k) : null)))
      .then(() => self.clients.claim())
  );
});

// fetch:
//  - navigations  → the cached app, instantly; network only if nothing is cached
//  - same-origin  → cache first, then network, and cache what comes back
//  - cross-origin → left alone
// Freshness is handled by the "check" message, not here.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate"){
    e.respondWith(
      caches.match(INDEX).then(hit => hit || fetch(req))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === "basic"){
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});

// "check" from a page: refresh the shell and, if the app code changed, tell
// every open window so each can offer a reload.
self.addEventListener("message", e => {
  if (e.data !== "check") return;
  e.waitUntil(
    refreshShell().then(changed => {
      if (!changed) return;
      return self.clients.matchAll({ type: "window" }).then(list => list.forEach(c => c.postMessage("updated")));
    })
  );
});
