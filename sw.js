const CACHE='tsod-20260710-12';
const ASSETS=['./','./index.html','./app.js','./manifest.json',
  './icon-192.png','./icon-512.png','./icon-180.png',
  './icon-maskable-512.png','./favicon-32.png'];
// Core code that must never be served stale against a mismatched partner file.
const CORE=['./','./index.html','./app.js'];
function isCore(url){
  const p=new URL(url).pathname.replace(/\/+$/,'/');
  return p.endsWith('/')||p.endsWith('/index.html')||p.endsWith('/app.js');
}
self.addEventListener('install',e=>{
  // no skipWaiting — page prompts the user before updating
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS).catch(()=>{})));
});
self.addEventListener('message',e=>{ if(e.data&&e.data.type==='SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=e.request.url;
  if(new URL(url).origin!==self.location.origin)return;
  if(isCore(url)){
    // NETWORK-FIRST for index.html + app.js: always try fresh code, fall back to
    // cache only when offline. This prevents a stale SW from serving an old app.js
    // against a new index.html (the classic PWA "dead buttons" trap).
    e.respondWith(
      fetch(e.request).then(resp=>{
        const cp=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cp)).catch(()=>{});return resp;
      }).catch(()=>caches.match(e.request).then(r=>{
        if(r) return r;
        // Do NOT substitute index.html for a missing script/asset — serving HTML as
        // app.js is the classic "dead buttons" trap. Only real navigations may fall
        // back to the app shell; anything else gets an honest offline error.
        if(e.request.mode==='navigate') return caches.match('./index.html');
        return new Response('/* offline: resource not cached */',{status:504,statusText:'Offline'});
      }))
    );
    return;
  }
  // CACHE-FIRST for static assets (icons, manifest).
  e.respondWith(
    caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
      const cp=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cp)).catch(()=>{});return resp;
    }).catch(()=>caches.match('./index.html')))
  );
});
