// Calisto · funciona sem internet. Gerado por montar-site.py (não editar à mão).
const CACHE='calisto-83b0359faa';
const APP=["./", "index.html", "sync.js", "spotify.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/icon-maskable-512.png"];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('calisto-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.origin===location.origin){
    // app: responde na hora com o que está guardado e busca a versão nova por trás
    e.respondWith(caches.open(CACHE).then(c=>c.match(r,{ignoreSearch:true}).then(m=>{
      const net=fetch(r).then(res=>{if(res.ok)c.put(r,res.clone());return res}).catch(()=>m||c.match('index.html'));
      return m||net;})));
  } else if(u.hostname==='www.gstatic.com'){
    // bibliotecas do Firebase: guardadas depois do primeiro uso
    e.respondWith(caches.open(CACHE).then(c=>c.match(r).then(m=>m||fetch(r).then(res=>{c.put(r,res.clone());return res}))));
  }
});
