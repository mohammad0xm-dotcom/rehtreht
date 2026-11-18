/* Cache-first service worker. Bump V after changing app files. OCR engine files live in a separate cache that is never deleted. */
const V='cardscan-v3',LIB='cardscan-lib',SHELL=['./','index.html','core.js','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'})))));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V&&x!==LIB).map(x=>caches.delete(x)))).then(()=>clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 const cross=new URL(e.request.url).origin!==location.origin;
 e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request).then(res=>{
  if(res.ok||res.type==='opaque'){const cp=res.clone();caches.open(cross?LIB:V).then(c=>c.put(e.request,cp))}
  return res})));
});
