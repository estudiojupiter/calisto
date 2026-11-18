// Calisto · playlists no Spotify (só na versão oficial; montar-site.py coloca no site).
// Login do Spotify sem senha passando pelo app (PKCE): o Spotify devolve um código e o app troca por um acesso.
// Permissão pedida: só criar e editar playlists. Nada fica guardado além do acesso, neste aparelho.
const CLIENT_ID = 'bd7c607d7ed24777b3485e2518eb13c2';
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = 'playlist-modify-private playlist-modify-public playlist-read-private'; // ler a playlist serve para respeitar as versões trocadas no Spotify
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
  tok = { a: j.access_token, r: j.refresh_token || (tok && tok.r), s: j.scope || (tok && tok.s) || '', exp: Date.now() + (j.expires_in - 60) * 1000 };
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
  if (s.sp && s.sp.uri) return { uri: s.sp.uri, duration_ms: 0, escolhida: true }; // versão que você escolheu no Spotify
  const t = limpa(s.title), a = String(s.artist || '').split(/[,/&]| e | feat\.? /i)[0].trim();
  const partes = t.includes('+') ? t.split('+').map(x => x.trim()).filter(Boolean) : [t]; // "Marcha Nupcial + No Fundo do Coração": tenta a 1ª parte
  const tentativas = [];
  for (const tt of partes) { if (a) tentativas.push([`track:${tt} artist:${a}`, tt], [`${tt} ${a}`, tt]); tentativas.push([tt, tt]); }
  const artOk = x => a && (x.artists || []).some(y => bate(y.name, a) || nt(y.name).includes(nt(a)) || nt(a).includes(nt(y.name)));
  let reserva = null; // mesma música, outro artista: só se não achar a do artista certo
  for (const [q, alvo] of tentativas) {
    const r = await api('/search?' + new URLSearchParams({ q, type: 'track', limit: '10' }));
    const its = ((r && r.tracks && r.tracks.items) || []).filter(x => bate(x.name, alvo));
    const certo = its.find(artOk); if (certo) return certo;
    if (!reserva && its[0]) reserva = its[0];
  }
  return reserva;
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

// lê o que está hoje na playlist do Spotify
async function lerAtual(p) {
  const atual = []; let url = `/playlists/${p.spotify.id}/items?limit=100`;
  for (let g = 0; url && g < 10; g++) {
    let r; try { r = await api(url); } catch (e) { if (e.status === 404 && url.includes('/items')) { url = url.replace('/items', '/tracks'); r = await api(url); } else throw e; }
    for (const x of (r && r.items) || []) { const t = x.track || x.item; if (t && t.uri) atual.push(t); }
    url = r && r.next ? r.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return atual;
}
const artistas = t => (t.artists || []).map(a => a.name).join(', ');
// aprende as trocas que você fez direto no Spotify (ex.: a versão ao vivo de um show)
async function aprender(p, atual) {
  if (!(p.spotify && p.spotify.id && p.spotify.map && p.spotify.map.length)) return 0;
  let n = 0;
  try {
    atual = atual || await lerAtual(p);
    const naLista = new Set(atual.map(t => t.uri)), doMapa = new Set(p.spotify.map.map(m => m.uri));
    const novas = atual.filter(t => !doMapa.has(t.uri));
    const by0 = Object.fromEntries(app.state().songs.map(s => [s.id, s]));
    for (const m of p.spotify.map) {
      if (naLista.has(m.uri)) continue;
      const s = by0[m.song]; if (!s) continue;
      const k = novas.findIndex(t => bate(t.name, limpa(s.title).split('+')[0]));
      if (k >= 0) { const t = novas.splice(k, 1)[0]; s.sp = { uri: t.uri, nome: t.name, art: artistas(t) }; m.uri = t.uri; n++; }
    }
    if (n) app.save();
  } catch (e) { console.warn('Calisto spotify: não deu para ler a playlist', e); }
  return n;
}

// tela "Conferir no Spotify": cada música do set com a faixa escolhida, e o botão Trocar
const escH = x => String(x || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function conferir(p) {
  if (!(await access())) { connect(p.id); return; }
  if (!/playlist-read-private/.test(tok.s || '')) { connect(p.id); return; }
  if (!(p.spotify && p.spotify.id)) { create(p); return; }
  app.toast('Lendo a playlist no Spotify…');
  let atual; try { atual = await lerAtual(p); } catch (e) { app.toast('Não deu para ler a playlist agora.'); return; }
  const n = await aprender(p, atual);
  const porUri = Object.fromEntries(atual.map(t => [t.uri, t]));
  const by = Object.fromEntries(app.state().songs.map(s => [s.id, s]));
  const linhas = (p.spotify.map || []).map((m, i) => {
    const s = by[m.song]; if (!s) return '';
    const t = porUri[m.uri];
    const faixa = t ? `${escH(t.name)} — ${escH(artistas(t))}` : '<i>não está mais na playlist</i>';
    return `<div style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">
      <div style="flex:1;min-width:0"><div style="font-weight:600">${i + 1}. ${escH(s.title)}${s.sp ? ' <span title="Versão escolhida por você" style="color:#1ed760">●</span>' : ''}</div>
      <div style="color:var(--muted);font-size:.82rem">${faixa}</div></div>
      <button class="mini" data-troca="${escH(m.song)}">Trocar</button></div>`;
  }).join('');
  const faltou = (p.spotify.miss || []).length ? `<p style="color:var(--muted);margin:8px 0 0">Não achei: ${p.spotify.miss.map(escH).join(', ')}.</p>` : '';
  app.modal('Conferir no Spotify', `${n ? `<p style="color:#1ed760;margin:0 0 8px">Guardei ${n} troca${n > 1 ? 's' : ''} que você fez no Spotify.</p>` : ''}
    <p style="color:var(--muted);margin:0 0 6px;font-size:.85rem">● = versão escolhida por você. Ela vale para essa música em todos os sets.</p>${linhas}${faltou}`,
  e => { const b = e.target.closest('[data-troca]'); if (b) escolher(p, by[b.dataset.troca]); }, null, 'Fechar');
}
async function escolher(p, s) {
  if (!s) return;
  app.toast('Procurando versões…');
  const t = limpa(s.title).split('+')[0].trim(), a = String(s.artist || '').split(/[,/&]| e | feat\.? /i)[0].trim();
  const vistos = new Set(), op = [];
  for (const q of [a ? `track:${t} artist:${a}` : t, t, `${t} ao vivo`, `${t} live`]) {
    try { const r = await api('/search?' + new URLSearchParams({ q, type: 'track', limit: '8' }));
      for (const x of (r && r.tracks && r.tracks.items) || []) if (!vistos.has(x.uri) && bate(x.name, t)) { vistos.add(x.uri); op.push(x); } } catch (e) {}
    if (op.length >= 15) break;
  }
  const mm = d => { d = Math.round((d || 0) / 1000); return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0'); };
  app.modal(`Versão de "${s.title}"`, `<p style="color:var(--muted);margin:0 0 6px;font-size:.85rem">Toque na versão certa. A playlist do Spotify é atualizada e o link continua o mesmo.</p>
    ${op.map((x, i) => `<button class="big" data-v="${i}" style="text-align:left"><span style="flex:1;min-width:0"><b>${escH(x.name)}</b><br><small style="color:var(--muted)">${escH(artistas(x))} · ${escH(x.album && x.album.name)} · ${mm(x.duration_ms)}</small></span>${s.sp && s.sp.uri === x.uri ? ' ✓' : ''}</button>`).join('') || '<p>Não achei versões com esse nome.</p>'}
    ${s.sp ? '<button class="big" data-v="auto" style="color:var(--muted)">Voltar para a escolha automática <span>›</span></button>' : ''}`,
  e => { const b = e.target.closest('[data-v]'); if (!b) return;
    if (b.dataset.v === 'auto') delete s.sp; else { const x = op[+b.dataset.v]; s.sp = { uri: x.uri, nome: x.name, art: artistas(x) }; if (!s.dur && x.duration_ms) s.dur = Math.round(x.duration_ms / 1000); }
    app.save(); app.close(); create(p).then(() => {}); }, null, 'Cancelar');
}

let rodando = false;
async function create(p) {
  if (rodando) return; if (!p.items.length) { app.toast('Playlist vazia'); return; }
  if (!(await access())) { connect(p.id); return; }
  if (p.spotify && p.spotify.id && !/playlist-read-private/.test(tok.s || '')) { connect(p.id); return; } // precisa da permissão nova uma vez
  const aprendeu = await aprender(p);
  rodando = true;
  const S = app.state(), by = Object.fromEntries(S.songs.map(s => [s.id, s]));
  const uris = [], miss = [], mapa = []; let durs = 0, i = 0;
  try {
    for (const id of p.items) {
      const s = by[id]; if (!s) continue;
      app.toast(`Procurando no Spotify… ${++i}/${p.items.length}`);
      const it = await acha(s);
      if (!it) { miss.push(s.title); continue; }
      uris.push(it.uri); mapa.push({ song: id, uri: it.uri });
      if (!s.dur && it.duration_ms) { s.dur = Math.round(it.duration_ms / 1000); durs++; }
    }
    if (!uris.length) { app.toast('Não achei nenhuma dessas músicas no Spotify.'); return; }
    let pl;
    if (p.spotify && p.spotify.id) { try { await api(`/playlists/${p.spotify.id}`, { method: 'PUT', body: JSON.stringify({ name: p.name }) }); pl = { id: p.spotify.id, external_urls: { spotify: p.spotify.url } }; } catch (e) { pl = null; } }
    if (!pl) pl = await novaPlaylist(p.name);
    await poeItens(pl.id, uris);
    p.spotify = { id: pl.id, url: pl.external_urls.spotify, n: uris.length, miss, map: mapa, t: Date.now() };
    app.save(); app.redraw();
    const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    app.modal('No Spotify ✓', `
      <p style="margin:0 0 8px"><b>${esc(p.name)}</b>: ${uris.length} de ${p.items.length} músicas, na ordem do set.${durs ? ` Ganhei a duração de ${durs} música${durs > 1 ? 's' : ''}.` : ''}${aprendeu ? ` Guardei ${aprendeu} versão${aprendeu > 1 ? 'ões' : ''} que você trocou no Spotify.` : ''}</p>
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

window.calistoSpotify = { create, conferir, connected: () => !!tok, connect: () => connect(null), disconnect: () => { keep(tok = null); app.redraw(); } };
app.redraw();
