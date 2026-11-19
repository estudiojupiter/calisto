// Calisto · funciona sem internet. Gerado por montar-site.py (não editar à mão).
const CACHE='calisto-48dbf9fe72';
const APP=["./", "index.html", "sync.js", "spotify.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/icon-maskable-512.png"];
const FB=['app','auth','firestore'].map(m=>'https://www.gstatic.com/firebasejs/10.12.2/firebase-'+m+'.js');
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP))
  .then(()=>caches.open('calisto-libs-v1')).then(c=>Promise.all(FB.map(u=>c.match(u).then(m=>m||c.add(u).catch(()=>{}))))) // tenta guardar o login já na instalação; se falhar, guarda no primeiro uso
  .then(()=>self.skipWaiting()))});
const LIBS='calisto-libs-v1'; // bibliotecas de fora (Firebase): ficam entre as versões, para o login funcionar sem internet logo depois de atualizar
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('calisto-')&&k!==CACHE&&k!==LIBS).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
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
    e.respondWith(caches.open(LIBS).then(c=>c.match(r).then(m=>m||fetch(r).then(res=>{if(res.ok)c.put(r,res.clone());return res}))));
  }
});
