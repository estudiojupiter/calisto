// Calisto · login e sincronização (Firebase). Só entra na versão oficial (montar-site.py).
// Modelo: users/{uid}/songs/{id} = {j: JSON da música, u: hora do servidor, del?: true}
//         users/{uid}/meta/state  = {j: JSON {pls, prefs, singers}, u}
// O aparelho continua guardando tudo (funciona sem internet); a nuvem só junta Mac e celular.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, query, where, writeBatch, serverTimestamp,
  Timestamp, onSnapshot, setDoc, addDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const fb = initializeApp({
  apiKey: 'AIzaSyBuAc6ADu1qf5RIIGPdY_oB_jHRGCB5WXs',
  authDomain: 'calisto-15d91.firebaseapp.com',
  projectId: 'calisto-15d91',
  storageBucket: 'calisto-15d91.firebasestorage.app',
  messagingSenderId: '669364392592',
  appId: '1:669364392592:web:d47db6a90f572aa19f3e15'
});
const auth = getAuth(fb), db = getFirestore(fb);
const app = await (window.calistoReady || Promise.resolve(window.calistoApp)); // a biblioteca carrega do IndexedDB antes
const btn = document.getElementById('cloudBtn');
if (!app || !btn) throw new Error('Calisto: app não encontrado');
btn.hidden = false;

// ---------- estado local da sincronização ----------
const KEY = 'calisto.sync';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
if (window.calistoHealed) { try { localStorage.removeItem(KEY); } catch (e) {} } // o app consertou músicas quebradas: puxa tudo de novo da nuvem
let st = load();
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };
function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const metaOf = ({ pls, prefs, ui }) => ({ pls, prefs, singers: ui.singers || [] });
// 20/11: playlists mexidas em dois aparelhos ao mesmo tempo: junta item por item, usando a última versão sincronizada como base.
// Mudou só de um lado: vale esse lado. Mudou dos dois: vale o aparelho (é o que acabou de ser mexido). Apagada de um lado e intacta do outro: some.
const J = x => JSON.stringify(x);
function merge3(base, loc, rem) {
  const byId = a => new Map((a || []).map(p => [p.id, p]));
  const B = byId(base.pls), L = byId(loc.pls), R = byId(rem.pls), out = [];
  const pick = (b, l, r) => { if (l && r) return J(l) === J(b) ? r : l; if (l) return b && J(l) === J(b) ? null : l; if (r) return b && J(r) === J(b) ? null : r; return null; };
  for (const p of loc.pls || []) { const v = pick(B.get(p.id), p, R.get(p.id)); if (v) out.push(v); }
  (rem.pls || []).forEach((p, i) => { if (L.has(p.id)) return; const v = pick(B.get(p.id), null, p); if (v) out.splice(Math.min(i, out.length), 0, v); });
  const prefs = {}, bp = base.prefs || {}, lp = loc.prefs || {}, rp = rem.prefs || {};
  for (const k of new Set([...Object.keys(lp), ...Object.keys(rp)])) { const v = pick(bp[k], lp[k], rp[k]); if (v) prefs[k] = v; }
  const bs = J(base.singers || []), singers = J(loc.singers || []) === bs ? rem.singers : J(rem.singers || []) === bs ? loc.singers : [...new Set([...(loc.singers || []), ...(rem.singers || [])])];
  return { pls: out, prefs, singers: singers || [] };
}
// cada aparelho tem um nome; quando um sobe mudança, avisa os outros pelo "sinal" (meta/ping) e eles puxam na hora
const DEV = (() => { try { let d = localStorage.getItem('calisto.dev'); if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem('calisto.dev', d); } return d; } catch (e) { return Math.random().toString(36).slice(2, 10); } })();
const kTA = s => (s.title || '').trim().toLowerCase() + '|' + (s.artist || '').trim().toLowerCase();

let user = null, busy = false, again = false, timer = 0, status = 'out', lastOk = 0;
function show(s) {
  status = s;
  btn.textContent = { out: '☁︎ Entrar', sync: '☁︎ …', ok: '☁︎ ✓', off: '☁︎ sem rede' }[s];
  btn.title = { out: 'Entrar para sincronizar Mac e celular', sync: 'Sincronizando', ok: 'Sincronizado', off: 'Sem internet: salvo no aparelho, sincroniza depois' }[s];
}

// ---------- puxar da nuvem ----------
async function pull() {
  const first = st.uid !== user.uid;
  if (first) st = { uid: user.uid, last: 0, mlast: 0, h: {}, mh: '' };
  // 20/11: busca tudo da nuvem ANTES de ler o aparelho. Antes lia o aparelho, esperava a rede e aplicava a foto velha:
  // o que a pessoa criava ou editava durante a espera (ex.: "Gravar agora" quando o outro aparelho mandava o sinal) sumia.
  const [snap, m] = await Promise.all([
    getDocs(query(collection(db, 'users', user.uid, 'songs'), where('u', '>', Timestamp.fromMillis(Math.max(0, st.last - 60000))))),
    getDoc(doc(db, 'users', user.uid, 'meta', 'state'))]);
  // daqui até o fim não há mais espera: nada que a pessoa fizer se perde
  const S = app.state();
  let songs = S.songs.slice(), pls = S.pls, prefs = S.prefs, singers = (S.ui.singers || []).slice();
  let changed = false;
  const byId = new Map(songs.map(s => [s.id, s]));
  const remap = {}; // 1º login neste aparelho: a mesma música com outro id vira a da nuvem

  const byTA = first ? new Map(songs.map(s => [kTA(s), s])) : null;
  snap.forEach(d => {
    const v = d.data(), id = d.id, ms = v.u ? v.u.toMillis() : 0;
    if (ms > st.last) st.last = ms;
    const loc = byId.get(id);
    const dirty = loc && st.h[id] !== undefined && hash(JSON.stringify(loc)) !== st.h[id];
    if (dirty) return; // mudou aqui e ainda não subiu: o aparelho ganha
    if (v.del) { if (loc) { songs = songs.filter(s => s.id !== id); byId.delete(id); changed = true; } delete st.h[id]; return; }
    if (!loc && st.h[id] !== undefined) return; // 20/11: apagada aqui e ainda não subiu (a busca repete o último minuto): não volta; o push apaga na nuvem
    if (loc && JSON.stringify(loc) === v.j) { st.h[id] = hash(v.j); return; } // igual: não troca nada
    const song = JSON.parse(v.j);
    if (first && !loc) {
      const twin = byTA.get(kTA(song));
      if (twin && twin.id !== id) { remap[twin.id] = id; songs = songs.filter(s => s !== twin); byId.delete(twin.id); }
    }
    if (loc) songs[songs.indexOf(loc)] = song; else songs.push(song);
    byId.set(id, song); st.h[id] = hash(JSON.stringify(song)); changed = true;
  });

  if (Object.keys(remap).length) {
    const r = x => remap[x] || x;
    pls = pls.map(p => { const tr = {}; for (const k in p.tr || {}) tr[r(k)] = p.tr[k]; return Object.assign({}, p, { items: [...new Set(p.items.map(r))], tr }); });
    const np = {}; for (const k in prefs) { const nk = r(k); np[nk] = Object.assign({}, prefs[k], np[nk] || {}); } prefs = np;
  }

  if (m.exists()) {
    const v = m.data(), ms = v.u ? v.u.toMillis() : 0;
    const localDirty = !first && hash(JSON.stringify(metaOf(S))) !== st.mh;
    if (ms > st.mlast && !localDirty) {
      const rm = JSON.parse(v.j);
      if (first) { // junta: playlists pelo nome (a da nuvem vale), tons, artistas
        const names = new Set(rm.pls.map(p => p.name.trim().toLowerCase()));
        pls = rm.pls.concat(pls.filter(p => !names.has(p.name.trim().toLowerCase())));
        prefs = Object.assign({}, prefs, rm.prefs);
        singers = [...new Set(rm.singers.concat(singers))];
      } else { pls = rm.pls; prefs = rm.prefs; singers = rm.singers; st.mh = hash(JSON.stringify(rm)); st.mb = v.j; }
      changed = true;
    } else if (ms > st.mlast && localDirty && st.mb) { // mexeu aqui e no outro aparelho: junta (e o push manda o resultado)
      const mg = merge3(JSON.parse(st.mb), metaOf(S), JSON.parse(v.j));
      pls = mg.pls; prefs = mg.prefs; singers = mg.singers; changed = true;
    }
    if (ms > st.mlast) st.mlast = ms;
  }
  if (changed || Object.keys(remap).length) app.apply({ songs, pls, prefs, singers });
  keep();
}

// ---------- subir para a nuvem ----------
async function push() {
  const S = app.state(), ops = [], ids = new Set();
  for (const s of S.songs) {
    if (!s || !s.id || !s.title) continue; // nunca sobe música quebrada
    ids.add(s.id);
    const j = JSON.stringify(s), h = hash(j);
    if (st.h[s.id] !== h) ops.push({ id: s.id, data: { j, u: serverTimestamp() }, h });
  }
  const gone = Object.keys(st.h).filter(id => !ids.has(id));
  // trava de segurança: sumir muita música de uma vez é erro, não decisão; não apaga na nuvem e puxa tudo de novo
  if (gone.length > 20 && gone.length > Object.keys(st.h).length * 0.1) {
    console.warn('Calisto: ' + gone.length + ' músicas sumiram de uma vez; não apaguei na nuvem');
    st = {}; keep(); throw new Error('muitas músicas sumiram');
  }
  for (const id of gone) ops.push({ id, data: { del: true, u: serverTimestamp() }, h: null });
  const mj = JSON.stringify(metaOf(S)), mh = hash(mj);
  const metaDirty = mh !== st.mh;
  if (!ops.length && !metaDirty) return 0;
  for (let i = 0; i < ops.length; i += 400) {
    const part = ops.slice(i, i + 400), b = writeBatch(db);
    for (const o of part) b.set(doc(db, 'users', user.uid, 'songs', o.id), o.data);
    await b.commit();
    for (const o of part) { if (o.h) st.h[o.id] = o.h; else delete st.h[o.id]; }
    keep();
  }
  if (metaDirty) {
    const b = writeBatch(db);
    b.set(doc(db, 'users', user.uid, 'meta', 'state'), { j: mj, u: serverTimestamp() });
    await b.commit(); st.mh = mh; st.mb = mj; keep();
  }
  try { await setDoc(doc(db, 'users', user.uid, 'meta', 'ping'), { dev: DEV, u: serverTimestamp() }); } catch (e) {}
  return ops.length + (metaDirty ? 1 : 0);
}

async function sync(manual) {
  if (!user) return;
  if (busy) { again = true; return; }
  busy = true; show('sync');
  try {
    await pull();
    const n = await push();
    lastOk = Date.now(); show('ok');
    if (manual) app.toast(n ? `Sincronizado (${n} mudança${n > 1 ? 's' : ''} enviada${n > 1 ? 's' : ''})` : 'Tudo sincronizado');
  } catch (e) {
    console.warn('Calisto sync', e);
    show('off');
    if (manual) app.toast(navigator.onLine ? 'Não deu para sincronizar agora. Tenta de novo daqui a pouco.' : 'Sem internet: está tudo salvo no aparelho.');
  } finally {
    busy = false;
    if (again) { again = false; setTimeout(sync, 300); }
  }
}

// 20/11: sugestões dos testadores ficam na conta de cada um (users/{uid}/sugestoes); o Gui lê no console do Firebase
async function sugestao(o) {
  if (!user) throw Object.assign(new Error('sem login'), { login: true });
  const ok = x => String(x == null ? '' : x).slice(0, 4000);
  await addDoc(collection(db, 'users', user.uid, 'sugestoes'), { tipo: ok(o.tipo), texto: ok(o.texto), tela: ok(o.tela), aparelho: ok(navigator.userAgent), versao: ok(o.versao), email: user.email || '', u: serverTimestamp() });
}
window.calistoSync = { changed() { if (!user) return; clearTimeout(timer); timer = setTimeout(sync, 2000); }, now: () => sync(true),
  sugestao, logado: () => !!user, entrar: () => loginBox(), perfil: () => perfilBox() };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
addEventListener('online', () => sync());

// ---------- telas ----------
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function loginBox(msg) {
  app.modal('Entrar no Calisto', `
    <p style="color:var(--muted);margin:0 0 10px">Com o login, as cifras e playlists ficam iguais no Mac e no celular. Sem login, tudo continua salvo só neste aparelho.</p>
    <input id="cEmail" type="email" autocomplete="username" placeholder="E-mail" style="width:100%;margin-bottom:8px">
    <input id="cPass" type="password" autocomplete="current-password" placeholder="Senha (6 caracteres ou mais)" style="width:100%;margin-bottom:10px">
    ${msg ? `<p style="color:var(--danger);margin:0 0 10px">${esc(msg)}</p>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="primary" data-a="in" style="flex:1">Entrar</button>
      <button data-a="new" style="flex:1">Criar conta</button>
    </div>
    <button data-a="reset" style="margin-top:8px;width:100%;background:none;border:none;color:var(--muted)">Esqueci a senha</button>`,
  async e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    const em = document.getElementById('cEmail').value.trim(), pw = document.getElementById('cPass').value;
    const err = c => ({ 'auth/invalid-credential': 'E-mail ou senha não conferem.', 'auth/wrong-password': 'Senha errada.',
      'auth/user-not-found': 'Não achei conta com esse e-mail. Toque em Criar conta.', 'auth/email-already-in-use': 'Esse e-mail já tem conta. Toque em Entrar.',
      'auth/weak-password': 'A senha precisa de 6 caracteres ou mais.', 'auth/invalid-email': 'Confira o e-mail.',
      'auth/network-request-failed': 'Sem internet agora.', 'auth/too-many-requests': 'Muitas tentativas. Espera um pouco.' }[c] || 'Não deu certo (' + c + ').');
    try {
      if (a.dataset.a === 'reset') { if (!em) return loginBox('Escreva o e-mail primeiro.'); await sendPasswordResetEmail(auth, em); app.toast('Mandei um e-mail para trocar a senha.'); return; }
      if (!em || !pw) return loginBox('Preencha e-mail e senha.');
      a.disabled = true; a.textContent = '…';
      if (a.dataset.a === 'new') await createUserWithEmailAndPassword(auth, em, pw); else await signInWithEmailAndPassword(auth, em, pw);
      app.close();
    } catch (x) { loginBox(err(x.code)); setTimeout(() => { const i = document.getElementById('cEmail'); if (i) i.value = em; }, 0); }
  });
}
function accountBox() {
  const t = lastOk ? new Date(lastOk).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  app.modal('Conta', `
    <p style="margin:0 0 4px">${esc(user.email)}</p>
    <p style="color:var(--muted);margin:0 0 12px">${{ ok: 'Sincronizado', sync: 'Sincronizando…', off: 'Sem internet: salvo no aparelho' }[status] || ''} · última vez às ${t}</p>
    <button class="big" data-a="now">Sincronizar agora <span>›</span></button>
    <button class="big" data-a="perfil">Sobre você <span>›</span></button>
    <button class="big" data-a="out">Sair desta conta <span>›</span></button>`,
  async e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'now') { app.close(); sync(true); }
    if (a.dataset.a === 'perfil') { app.close(); setTimeout(perfilBox, 300); }
    if (a.dataset.a === 'out') { app.close(); await signOut(auth); app.toast('Saiu. As cifras continuam neste aparelho.'); }
  });
}
btn.addEventListener('click', () => user ? accountBox() : loginBox());

show('out');
let unPing = null;
function listen() {
  if (unPing) { unPing(); unPing = null; }
  if (!user) return;
  // ao vivo: mudou no Mac, o celular puxa em segundos (e vice-versa), sem precisar fechar e abrir
  unPing = onSnapshot(doc(db, 'users', user.uid, 'meta', 'ping'), d => {
    if (d.metadata.hasPendingWrites) return;
    const v = d.data(); if (v && v.dev && v.dev !== DEV) { clearTimeout(timer); timer = setTimeout(sync, 400); }
  }, e => console.warn('Calisto ao vivo', e));
}
// ---------- 20/11: "sobre você", uma vez, logo depois do primeiro login (pulável) ----------
const PK = () => 'calisto.perfil.' + (user && user.uid);
let perfilAtual = null;
async function perfilBox() {
  if (!user) return;
  if (!perfilAtual) { try { const d = await getDoc(doc(db, 'users', user.uid, 'meta', 'perfil')); perfilAtual = d.exists() ? d.data() : {}; } catch (e) { perfilAtual = {}; } }
  const P = Object.assign({ nome: '', faz: ['músico'], instrumento: '', onde: [], indicou: '', novidades: false }, perfilAtual);
  const chips = (k, op) => op.map(o => `<button class="mini${(P[k] || []).includes(o) ? ' on' : ''}" data-ch="${k}:${o}">${o}</button>`).join('');
  const html = () => `<p style="color:var(--muted);margin:0 0 10px">Leva 20 segundos. Tudo opcional.</p>
    <label class="pf">Como quer ser chamado<input class="f" id="pfNome" value="${esc(P.nome)}" maxlength="60"></label>
    <div class="pf">O que você faz<div class="chips">${chips('faz', ['músico', 'professor', 'produtor', 'compositor'])}</div></div>
    <label class="pf">Instrumento<input class="f" id="pfInst" value="${esc(P.instrumento)}" maxlength="60" placeholder="Ex.: violão e voz"></label>
    <div class="pf">Onde vai usar<div class="chips">${chips('onde', ['celular', 'iPad', 'computador'])}</div></div>
    <label class="pf">Quem indicou<input class="f" id="pfInd" value="${esc(P.indicou)}" maxlength="60"></label>
    <label class="pfchk"><input type="checkbox" id="pfNov" ${P.novidades ? 'checked' : ''}> Quero receber novidades do Calisto por e-mail (dá para sair quando quiser).</label>
    <p style="color:var(--muted);font-size:.8rem;margin:8px 0 12px">Seus dados ficam na sua conta e servem só para melhorar o app. Para apagar, peça em “Mandar sugestão”. Lei Geral de Proteção de Dados (LGPD).</p>
    <div style="display:flex;gap:8px"><button class="primary" data-a="ok" style="flex:1;min-height:46px">Salvar</button><button data-a="pular">Pular</button></div>`;
  const ler = () => { P.nome = document.getElementById('pfNome').value.trim(); P.instrumento = document.getElementById('pfInst').value.trim(); P.indicou = document.getElementById('pfInd').value.trim(); P.novidades = document.getElementById('pfNov').checked; };
  const grava = async (dados) => { try { localStorage.setItem(PK(), '1'); } catch (e) {} try { await setDoc(doc(db, 'users', user.uid, 'meta', 'perfil'), Object.assign({}, dados, { u: serverTimestamp() })); perfilAtual = dados; } catch (e) { console.warn('Calisto perfil', e); } };
  app.modal('Sobre você', html(), async e => {
    const c = e.target.closest('[data-ch]');
    if (c) { ler(); const [k, v] = c.dataset.ch.split(':'); P[k] = (P[k] || []).includes(v) ? P[k].filter(x => x !== v) : [...(P[k] || []), v]; document.getElementById('mBody').innerHTML = html(); return; }
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'pular') { app.close(); if (!perfilAtual || !Object.keys(perfilAtual).length) grava({ pulou: true }); return; }
    ler(); app.close(); await grava({ nome: P.nome, faz: P.faz, instrumento: P.instrumento, onde: P.onde, indicou: P.indicou, novidades: P.novidades }); app.toast('Obrigado!');
  }, null, 'Fechar');
}
async function perfilPrimeiraVez() {
  try { if (localStorage.getItem(PK())) return; } catch (e) {}
  try { const d = await getDoc(doc(db, 'users', user.uid, 'meta', 'perfil')); if (d.exists()) { perfilAtual = d.data(); try { localStorage.setItem(PK(), '1'); } catch (e) {} return; } } catch (e) { return; }
  const tenta = (n) => { if (!user) return; if (document.getElementById('modal').hidden && document.getElementById('editor').hidden && (!document.getElementById('coach') || document.getElementById('coach').hidden)) perfilBox(); else if (n < 20) setTimeout(() => tenta(n + 1), 3000); };
  setTimeout(() => tenta(0), 2500);
}
onAuthStateChanged(auth, u => { user = u; perfilAtual = null; listen(); if (u) { sync(); perfilPrimeiraVez(); } else show('out'); });
