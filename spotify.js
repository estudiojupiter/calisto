// Calisto · playlists no Spotify (só na versão oficial; montar-site.py coloca no site).
// Login do Spotify sem senha passando pelo app (PKCE): o Spotify devolve um código e o app troca por um acesso.
// Permissão pedida: só criar e editar playlists. Nada fica guardado além do acesso, neste aparelho.
const CLIENT_ID = 'bd7c607d7ed24777b3485e2518eb13c2';
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = 'playlist-modify-private playlist-modify-public';
const KEY = 'calisto.spotify', PEND = 'calisto.spotify.pend';
const app = window.calistoApp;

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } };
const keep = t => { try { t ? localStorage.setItem(KEY, JSON.stringify(t)) : localStorage.removeItem(KEY); } catch (e) {} };
let tok = load();

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function connect(after) {
  const v = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const ch = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
  localStorage.setItem(PEND, JSON.stringify({ v, after: after || null, t: Date.now() }));
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: ch });
}
async function tokenCall(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.assign({ client_id: CLIENT_ID }, body)) });
  if (!r.ok) throw new Error('token ' + r.status);
  const j = await r.json();
  tok = { a: j.access_token, r: j.refresh_token || (tok && tok.r), exp: Date.now() + (j.expires_in - 60) * 1000 };
  keep(tok); return tok;
}
async function access() {
  if (!tok) return null;
  if (Date.now() < tok.exp) return tok.a;
  try { await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.r }); return tok.a; } catch (e) { keep(tok = null); return null; }
}
async function api(path, opt = {}) {
  const a = await access(); if (!a) throw Object.assign(new Error('sem login'), { login: true });
  for (let tent = 0; tent < 4; tent++) {
    const r = await fetch('https://api.spotify.com/v1' + path, Object.assign({}, opt, { headers: Object.assign({ Authorization: 'Bearer ' + a, 'Content-Type': 'application/json' }, opt.headers || {}) }));
    if (r.status === 429) { await new Promise(ok => setTimeout(ok, (+r.headers.get('Retry-After') || 1) * 1000 + 300)); continue; }
    if (r.status === 401) { keep(tok = null); throw Object.assign(new Error('login expirou'), { login: true }); }
    if (!r.ok) throw Object.assign(new Error(path + ' ' + r.status), { status: r.status });
    const txt = await r.text(); return txt ? JSON.parse(txt) : null; /* o Spotify às vezes responde 200 sem corpo */
  }
  throw new Error('Spotify ocupado');
}

// volta do login do Spotify (?code=...)
(async () => {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  const pend = (() => { try { return JSON.parse(localStorage.getItem(PEND)); } catch (e) { return null; } })();
  history.replaceState(null, '', REDIRECT);
  localStorage.removeItem(PEND);
  if (q.has('error') || !pend) { app.toast('Spotify não conectado.'); return; }
  try {
    await tokenCall({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, code_verifier: pend.v });
    app.toast('Spotify conectado'); app.redraw();
    if (pend.after) { const p = app.state().pls.find(x => x.id === pend.after); if (p) setTimeout(() => create(p), 400); }
  } catch (e) { console.warn(e); app.toast('Não deu para conectar ao Spotify. Tenta de novo.'); }
})();

// ---------- achar as músicas e montar a playlist ----------
const limpa = t => String(t || '').replace(/\s*\(\d+\)\s*$/, '').replace(/\s*[\[(](ao vivo|live|ac[uú]stic[oa]|vers[aã]o.*?)[\])]/ig, '').trim();
const nt = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+-\s+.*$/, '').replace(/[\[(].*?[\])]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function bate(a, b) { // o nome da faixa do Spotify confere com o da cifra?
  a = nt(a); b = nt(b); if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  const A = new Set(a.split(' ')), B = b.split(' ');
  return B.filter(w => A.has(w)).length / Math.max(A.size, B.length) >= 0.6;
}
async function acha(s) {
  const t = limpa(s.title), a = String(s.artist || '').split(/[,/&]| e | feat\.? /i)[0].trim();
  const partes = t.includes('+') ? t.split('+').map(x => x.trim()).filter(Boolean) : [t]; // "Marcha Nupcial + No Fundo do Coração": tenta a 1ª parte
  const tentativas = [];
  for (const tt of partes) { if (a) tentativas.push([`track:${tt} artist:${a}`, tt], [`${tt} ${a}`, tt]); tentativas.push([tt, tt]); }
  for (const [q, alvo] of tentativas) {
    const r = await api('/search?' + new URLSearchParams({ q, type: 'track', limit: '5' }));
    const it = ((r && r.tracks && r.tracks.items) || []).find(x => bate(x.name, alvo));
    if (it) return it;
  }
  return null;
}
async function poeItens(id, uris) {
  // o Spotify trocou "tracks" por "items" em 2025: tenta o novo e cai no antigo
  const send = async (method, part) => {
    try { return await api(`/playlists/${id}/items`, { method, body: JSON.stringify({ uris: part }) }); }
    catch (e) { if (e.status === 404 || e.status === 405) return api(`/playlists/${id}/tracks`, { method, body: JSON.stringify({ uris: part }) }); throw e; }
  };
  await send('PUT', uris.slice(0, 100));
  for (let i = 100; i < uris.length; i += 100) await send('POST', uris.slice(i, i + 100));
}
async function novaPlaylist(nome) {
  const body = JSON.stringify({ name: nome, public: false, description: 'Set montado no Calisto' });
  try { return await api('/me/playlists', { method: 'POST', body }); }
  catch (e) { if (e.status !== 404 && e.status !== 405) throw e; const me = await api('/me'); return api(`/users/${me.id}/playlists`, { method: 'POST', body }); }
}

let rodando = false;
async function create(p) {
  if (rodando) return; if (!p.items.length) { app.toast('Playlist vazia'); return; }
  if (!(await access())) { connect(p.id); return; }
  rodando = true;
  const S = app.state(), by = Object.fromEntries(S.songs.map(s => [s.id, s]));
  const uris = [], miss = []; let durs = 0, i = 0;
  try {
    for (const id of p.items) {
      const s = by[id]; if (!s) continue;
      app.toast(`Procurando no Spotify… ${++i}/${p.items.length}`);
      const it = await acha(s);
      if (!it) { miss.push(s.title); continue; }
      uris.push(it.uri);
      if (!s.dur && it.duration_ms) { s.dur = Math.round(it.duration_ms / 1000); durs++; }
    }
    if (!uris.length) { app.toast('Não achei nenhuma dessas músicas no Spotify.'); return; }
    let pl;
    if (p.spotify && p.spotify.id) { try { await api(`/playlists/${p.spotify.id}`, { method: 'PUT', body: JSON.stringify({ name: p.name }) }); pl = { id: p.spotify.id, external_urls: { spotify: p.spotify.url } }; } catch (e) { pl = null; } }
    if (!pl) pl = await novaPlaylist(p.name);
    await poeItens(pl.id, uris);
    p.spotify = { id: pl.id, url: pl.external_urls.spotify, n: uris.length, miss, t: Date.now() };
    app.save(); app.redraw();
    const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    app.modal('No Spotify ✓', `
      <p style="margin:0 0 8px"><b>${esc(p.name)}</b>: ${uris.length} de ${p.items.length} músicas, na ordem do set.${durs ? ` Ganhei a duração de ${durs} música${durs > 1 ? 's' : ''}.` : ''}</p>
      ${miss.length ? `<p style="color:var(--muted);margin:0 0 10px">Não achei: ${miss.map(esc).join(', ')}.</p>` : ''}
      <a class="big" href="${esc(p.spotify.url)}" target="_blank" rel="noopener" style="display:flex;justify-content:space-between;text-decoration:none;color:#1ed760">Abrir no Spotify <span>›</span></a>
      <button class="big" data-a="share">Mandar o link <span>›</span></button>`,
    e => { if (e.target.closest('[data-a="share"]')) { const u = p.spotify.url; if (navigator.share) navigator.share({ title: p.name, url: u }).catch(() => {}); else navigator.clipboard.writeText(u).then(() => app.toast('Link copiado')); } });
  } catch (e) {
    console.warn('Calisto spotify', e);
    if (e.login) { connect(p.id); return; }
    app.toast(e.status === 403 ? 'O Spotify recusou (403). Confira se sua conta está liberada no app do Spotify.' : 'Não deu para falar com o Spotify agora. Tenta de novo.');
  } finally { rodando = false; }
}

window.calistoSpotify = { create, connected: () => !!tok, connect: () => connect(null), disconnect: () => { keep(tok = null); app.redraw(); } };
app.redraw();
