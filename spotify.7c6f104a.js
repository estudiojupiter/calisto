// Calisto · playlists no Spotify (só na versão oficial; montar-site.py coloca no site).
// Login do Spotify sem senha passando pelo app (PKCE): o Spotify devolve um código e o app troca por um acesso.
// Permissão pedida: só criar e editar playlists. Nada fica guardado além do acesso, neste aparelho.
const CLIENT_ID = 'bd7c607d7ed24777b3485e2518eb13c2';
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = 'playlist-modify-private playlist-modify-public playlist-read-private'; // ler a playlist serve para respeitar as versões trocadas no Spotify
const KEY = 'calisto.spotify', PEND = 'calisto.spotify.pend';
const app = await (window.calistoReady || Promise.resolve(window.calistoApp));

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
  // 20/11: só desconecta se o Spotify recusar o acesso (erro 400/401). Sem internet (no show), mantém a conexão para depois
  try { await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.r }); return tok.a; } catch (e) { if (/^token 40[01]$/.test(e.message)) keep(tok = null); return null; }
}
// conectado mas sem internet: avisa em vez de mandar para a página de login do Spotify
async function pronto(id) { if (await access()) return true; if (tok) app.toast('Sem conexão com o Spotify agora. Tenta de novo com internet.'); else connect(id); return false; }
async function api(path, opt = {}) {
  const a = await access(); if (!a) throw Object.assign(new Error(tok ? 'sem rede' : 'sem login'), { login: !tok });
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
  const a0 = a.replace(/ /g, ''), b0 = b.replace(/ /g, ''); if (a0 === b0) return true; /* 3AM = 3 AM */
  const A = new Set(a.split(' ')), B = b.split(' ');
  return B.filter(w => A.has(w)).length / Math.max(A.size, B.length) >= 0.6;
}
// composições suas (feitas na aba Composição) e músicas marcadas "não está no Spotify" ficam sem vínculo até você escolher uma faixa
const vSet = (p, s) => p && p.spv && p.spv[s.id]; // versão escolhida só para esta playlist
const semSpotify = (s, p) => { const v = vSet(p, s); if (v) return !!v.none; return !!((s.sp && s.sp.none) || ((s.fin || s.comp) && !(s.sp && s.sp.uri))); };
async function acha(s, p) {
  const vs = vSet(p, s); if (vs && vs.uri) return { uri: vs.uri, duration_ms: vs.ms || 0, escolhida: true };
  if (s.sp && s.sp.uri) return { uri: s.sp.uri, duration_ms: s.sp.ms || 0, escolhida: true }; // versão que você escolheu no Spotify
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
  const feitas = [];
  if (!(p.spotify && p.spotify.id && p.spotify.map && p.spotify.map.length)) return feitas;
  try {
    atual = atual || await lerAtual(p);
    const naLista = new Set(atual.map(t => t.uri)), doMapa = new Set(p.spotify.map.map(m => m.uri));
    const novas = atual.filter(t => !doMapa.has(t.uri)), plano = [];
    const by0 = Object.fromEntries(app.state().songs.map(s => [s.id, s]));
    for (const m of p.spotify.map) {
      if (naLista.has(m.uri)) continue;
      const s = by0[m.song]; if (!s) continue;
      let k = novas.findIndex(t => bate(t.name, limpa(s.title).split('+')[0]));
      if (k < 0) { const pos = p.spotify.map.indexOf(m), t0 = atual[pos]; if (t0 && !doMapa.has(t0.uri)) k = novas.indexOf(t0); } /* nome diferente: só vale se estiver na mesma posição */
      if (k >= 0) plano.push([m, s, novas.splice(k, 1)[0]]);
    }
    if (plano.length) {
      app.snap('trocas lidas do Spotify', refazer(p.id));
      for (const [m, s, t] of plano) { p.spv = p.spv || {}; p.spv[s.id] = { uri: t.uri, nome: t.name, art: artistas(t), ms: t.duration_ms || 0 }; s.dur = t.duration_ms ? Math.round(t.duration_ms / 1000) : s.dur; m.uri = t.uri; feitas.push(`${s.title} → ${t.name} (${artistas(t)})`); }
      app.save();
    }
  } catch (e) { console.warn('Calisto spotify: não deu para ler a playlist', e); }
  return feitas;
}
const avisoTrocas = f => f.length ? `<div style="border:1px solid #1ed760;border-radius:10px;padding:8px 10px;margin:0 0 10px"><b style="color:#1ed760">Guardei ${f.length === 1 ? 'esta troca' : 'estas trocas'} que você fez no Spotify:</b><br>${f.map(escH).join('<br>')}<br><small style="color:var(--muted)">Se alguma estiver errada, toque em Desfazer no aviso de baixo ou use Trocar.</small></div>` : '';

// tela "Conferir no Spotify": cada música do set com a faixa escolhida, e o botão Trocar
const escH = x => String(x || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function conferir(p) {
  if (!(await pronto(p.id))) return;
  if (!/playlist-read-private/.test(tok.s || '')) { connect(p.id); return; }
  if (!(p.spotify && p.spotify.id)) { create(p); return; }
  app.toast('Lendo a playlist no Spotify…');
  let atual; try { atual = await lerAtual(p); } catch (e) { app.toast('Não deu para ler a playlist agora.'); return; }
  const feitas = await aprender(p, atual);
  const porUri = Object.fromEntries(atual.map(t => [t.uri, t]));
  const by = Object.fromEntries(app.state().songs.map(s => [s.id, s]));
  const fora = new Set(p.spSkip || []);
  const linhas = p.items.map((id, i) => {
    const s = by[id]; if (!s) return '';
    const m = (p.spotify.map || []).find(x => x.song === id), t = m && porUri[m.uri];
    const faixa = fora.has(id) ? '<i>fora do Spotify neste set</i>' : semSpotify(s, p) ? '<i>sem música no Spotify</i>' : t ? `${escH(t.name)} — ${escH(artistas(t))}` : m ? '<i>não está mais na playlist</i>' : '<i>não achei no Spotify</i>';
    return `<div style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">
      <div style="flex:1;min-width:0"><div style="font-weight:600">${i + 1}. ${escH(s.title)}${fora.has(id) ? '' : vSet(p, s) ? ' <span title="Versão só desta playlist" style="color:#1ed760">◐</span>' : s.sp ? ' <span title="Versão escolhida por você para todas as playlists" style="color:#1ed760">●</span>' : ''}</div>
      <div style="color:var(--muted);font-size:.82rem">${faixa}</div></div>
      <button class="mini" data-troca="${escH(id)}">Trocar</button></div>`;
  }).join('');
  app.modal('Conferir no Spotify', `${avisoTrocas(feitas)}
    <p style="color:var(--muted);margin:0 0 6px;font-size:.85rem">● = versão sua para todas as playlists · ◐ = versão só desta playlist.</p>${linhas}`,
  e => { const b = e.target.closest('[data-troca]'); if (b) escolher(p, by[b.dataset.troca]); }, null, 'Fechar');
  if (feitas.length) app.toast(`${feitas.length} troca${feitas.length > 1 ? 's' : ''} do Spotify guardada${feitas.length > 1 ? 's' : ''}`, 1);
}
async function escolher(p, s) {
  if (!s) return;
  const t = limpa(s.title).split('+')[0].trim(), a = String(s.artist || '').split(/[,/&]| e | feat\.? /i)[0].trim();
  const mm = d => { d = Math.round((d || 0) / 1000); return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0'); };
  let op = [];
  const lista = () => op.map((x, i) => `<button class="big" data-v="${i}" style="text-align:left"><span style="flex:1;min-width:0"><b>${escH(x.name)}</b><br><small style="color:var(--muted)">${escH(artistas(x))} · ${escH(x.album && x.album.name)} · ${mm(x.duration_ms)}</small></span>${s.sp && s.sp.uri === x.uri ? ' ✓' : ''}</button>`).join('')
    || '<p style="color:var(--muted)">Não achei. Tenta escrever de outro jeito (ex.: nome da música + banda).</p>';
  app.modal(`Versão de "${s.title}"`, `<form id="spBusca" style="display:flex;gap:6px;margin:0 0 8px">
      <input id="spQ" type="search" enterkeyhint="search" autocomplete="off" value="${escH((t + ' ' + a).trim())}" placeholder="Buscar no Spotify" style="flex:1;min-width:0;font-size:16px;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:inherit">
      <button class="mini" type="submit" style="padding:0 14px">Buscar</button></form>
    ${p ? `<label style="display:flex;gap:8px;align-items:center;margin:0 0 8px;font-size:.92rem"><input type="checkbox" id="spSet" ${vSet(p, s) ? 'checked' : ''} style="width:20px;height:20px"> Só nesta playlist <small style="color:var(--muted)">(sem marcar, vale para todas)</small></label>` : ''}
    <p style="color:var(--muted);margin:0 0 6px;font-size:.85rem">Escreva o que quiser (música, banda, "ao vivo", nome do show). Toque na versão certa: a playlist é atualizada e o link continua o mesmo.</p>
    <div id="spRes"><p style="color:var(--muted)">Procurando…</p></div>
    ${s.sp ? '<button class="big" data-v="auto" style="color:var(--muted)">Voltar para a escolha automática <span>›</span></button>' : ''}
    ${s.sp && s.sp.none ? '' : '<button class="big" data-v="none" style="color:var(--muted)">Esta música não está no Spotify <small>(vale para todas as playlists)</small> <span>›</span></button>'}
    ${!p ? '' : (p.spSkip || []).includes(s.id) ? '<button class="big" data-v="in">Voltar a colocar no Spotify neste set <span>›</span></button>' : '<button class="big" data-v="out" style="color:var(--muted)">Deixar fora do Spotify só neste set <small>(ex.: já está dentro de um medley)</small> <span>›</span></button>'}`,
  e => { const b = e.target.closest('[data-v]'); if (!b) return;
    const v = b.dataset.v;
    app.snap(v === 'out' ? `tirar "${s.title}" do Spotify` : v === 'in' ? `voltar "${s.title}" ao Spotify` : `versão de "${s.title}"`, p ? refazer(p.id) : null);
    const soSet = p && document.getElementById('spSet') && document.getElementById('spSet').checked;
    if (v === 'auto') { delete s.sp; if (p && p.spv) delete p.spv[s.id]; }
    else if (v === 'none') { if (soSet) { p.spv = p.spv || {}; p.spv[s.id] = { none: true }; } else s.sp = { none: true }; }
    else if (v === 'out') p.spSkip = [...new Set([...(p.spSkip || []), s.id])];
    else if (v === 'in') { p.spSkip = (p.spSkip || []).filter(x => x !== s.id); if (!p.spSkip.length) delete p.spSkip; }
    else { const x = op[+v], esc2 = { uri: x.uri, nome: x.name, art: artistas(x), ms: x.duration_ms || 0 }; if (soSet) { p.spv = p.spv || {}; p.spv[s.id] = esc2; } else { s.sp = esc2; if (p && p.spv) delete p.spv[s.id]; } if (x.duration_ms) s.dur = Math.round(x.duration_ms / 1000); }
    app.save(); app.close(); if (p) create(p, { semAprender: true }).then(() => {}); else app.toast(v === 'none' ? 'Fica sem música do Spotify' : 'Vínculo guardado: vale para todas as playlists'); }, null, 'Cancelar');
  const res = document.getElementById('spRes');
  async function busca(qs, filtra) {
    const vistos = new Set(); op = []; res.innerHTML = '<p style="color:var(--muted)">Procurando…</p>';
    for (const q of qs) {
      try { const r = await api('/search?' + new URLSearchParams({ q, type: 'track', limit: '10' }));
        for (const x of (r && r.tracks && r.tracks.items) || []) if (!vistos.has(x.uri) && (!filtra || bate(x.name, t))) { vistos.add(x.uri); op.push(x); } } catch (e) {}
      if (op.length >= 15) break;
    }
    if (document.getElementById('spRes') === res) res.innerHTML = lista();
  }
  document.getElementById('spBusca').addEventListener('submit', e => { e.preventDefault(); const q = document.getElementById('spQ').value.trim(); if (q) { document.getElementById('spQ').blur(); busca([q], false); } });
  busca([a ? `track:${t} artist:${a}` : t, `${t} ${a}`.trim(), t, `${t} ao vivo`, `${t} live`], true);
}

let rodando = false;
function perguntaVinculo(p, novas) {
  app.modal('Composições sem Spotify', `<p style="margin:0 0 10px">${novas.length === 1 ? 'Esta música é composição sua e não tem' : 'Estas músicas são composições suas e não têm'} música do Spotify ligada:</p>
    ${novas.map(s => `<div style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)"><b style="flex:1;min-width:0">${escH(s.title)}</b><button class="mini" data-vinc="${escH(s.id)}">Procurar</button></div>`).join('')}
    <p style="color:var(--muted);margin:10px 0">Sem vínculo, ela fica de fora da playlist do Spotify e o app não inventa nenhuma faixa.</p>
    <button class="big" data-a="sem">Montar sem elas <span>›</span></button>`,
  e => { const b = e.target.closest('[data-vinc]'); if (b) { escolher(p, novas.find(s => s.id === b.dataset.vinc)); return; }
    if (e.target.closest('[data-a="sem"]')) { novas.forEach(s => { s.sp = { none: true }; }); app.save(); app.close(); create(p, { jaPerguntou: true }); } }, null, 'Cancelar');
}
// depois de um Desfazer: manda o set de volta ao Spotify como estava (espera se ainda estiver enviando)
const refazer = id => () => { const go = () => { if (rodando) return setTimeout(go, 500); const q = app.state().pls.find(x => x.id === id); if (q) create(q, { semAprender: true }); }; go(); };
async function create(p, opt = {}) {
  if (rodando) return; if (!p.items.length) { app.toast('Playlist vazia'); return; }
  if (!(await pronto(p.id))) return;
  if (p.spotify && p.spotify.id && !/playlist-read-private/.test(tok.s || '')) { connect(p.id); return; } // precisa da permissão nova uma vez
  // composições suas ainda sem decisão: pergunta antes de montar (uma vez por música)
  if (!opt.jaPerguntou) { const S0 = app.state(), novas = p.items.map(id => S0.songs.find(x => x.id === id)).filter(s => s && (s.fin || s.comp) && !s.sp && !vSet(p, s));
    if (novas.length) { perguntaVinculo(p, novas); return; } }
  const aprendeu = opt.semAprender ? [] : await aprender(p);
  rodando = true;
  const S = app.state(), by = Object.fromEntries(S.songs.map(s => [s.id, s]));
  const uris = [], miss = [], mapa = [], semV = []; let durs = 0, i = 0;
  try {
    const fora = new Set(p.spSkip || []), alvo = p.items.filter(id => by[id] && !fora.has(id));
    for (const id of alvo) {
      const s = by[id];
      app.toast(`Procurando no Spotify… ${++i}/${alvo.length}`);
      if (semSpotify(s, p)) { semV.push(s.title); if (s.dur) { delete s.dur; durs++; } continue; }
      const it = await acha(s, p);
      if (!it) { miss.push(s.title); continue; }
      uris.push(it.uri); mapa.push({ song: id, uri: it.uri });
      if (it.duration_ms) { const d = Math.round(it.duration_ms / 1000); if (s.dur !== d) { s.dur = d; durs++; } } // a duração vem só do Spotify
    }
    if (aprendeu.length) app.toast('Trocas do Spotify guardadas', 1);
    if (!uris.length) { app.toast('Não achei nenhuma dessas músicas no Spotify.'); return; }
    let pl;
    if (p.spotify && p.spotify.id) { try { await api(`/playlists/${p.spotify.id}`, { method: 'PUT', body: JSON.stringify({ name: p.name }) }); pl = { id: p.spotify.id, external_urls: { spotify: p.spotify.url } }; } catch (e) { pl = null; } }
    if (!pl) pl = await novaPlaylist(p.name);
    await poeItens(pl.id, uris);
    p.spotify = { id: pl.id, url: pl.external_urls.spotify, n: uris.length, miss, semV, map: mapa, t: Date.now() };
    app.save(); app.redraw();
    const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    app.modal('No Spotify ✓', `
      <p style="margin:0 0 8px"><b>${esc(p.name)}</b>: ${uris.length} de ${alvo.length} músicas, na ordem do set.${fora.size ? ` ${fora.size} ficou${fora.size > 1 ? 'aram' : ''} de fora por escolha sua.` : ''}${durs ? ` Ganhei a duração de ${durs} música${durs > 1 ? 's' : ''}.` : ''}</p>${avisoTrocas(aprendeu)}
      ${miss.length ? `<p style="color:var(--muted);margin:0 0 10px">Não achei: ${miss.map(esc).join(', ')}.</p>` : ''}
      ${semV.length ? `<p style="color:var(--muted);margin:0 0 10px">Sem música no Spotify (de propósito): ${semV.map(esc).join(', ')}. Para vincular, use Conferir → Trocar.</p>` : ''}
      <a class="big" href="${esc(p.spotify.url)}" target="_blank" rel="noopener" style="display:flex;justify-content:space-between;text-decoration:none;color:#1ed760">Abrir no Spotify <span>›</span></a>
      <button class="big" data-a="share">Mandar o link <span>›</span></button>`,
    e => { if (e.target.closest('[data-a="share"]')) { const u = p.spotify.url; if (navigator.share) navigator.share({ title: p.name, url: u }).catch(() => {}); else navigator.clipboard.writeText(u).then(() => app.toast('Link copiado')); } });
  } catch (e) {
    console.warn('Calisto spotify', e);
    if (e.login) { connect(p.id); return; }
    app.toast(e.status === 403 ? 'O Spotify recusou (403). Confira se sua conta está liberada no app do Spotify.' : 'Não deu para falar com o Spotify agora. Tenta de novo.');
  } finally { rodando = false; }
}

// 20/11: limpeza: as playlists que o Calisto criou no Spotify (pelo vínculo guardado e pela descrição "Set montado no Calisto")
async function listarCalisto() {
  const ach = new Map();
  for (const p of app.state().pls) if (p.spotify && p.spotify.id) ach.set(p.spotify.id, { id: p.spotify.id, nome: p.name });
  try {
    const me = await api('/me'); let url = '/me/playlists?limit=50';
    for (let g = 0; url && g < 20; g++) { const r = await api(url);
      for (const x of (r && r.items) || []) if (x && x.owner && x.owner.id === me.id && /Set montado no Calisto/.test(x.description || '')) ach.set(x.id, { id: x.id, nome: x.name });
      url = r && r.next ? r.next.replace('https://api.spotify.com/v1', '') : null; }
  } catch (e) { if (e.login) throw e; console.warn('Calisto spotify: listar', e); }
  return [...ach.values()];
}
async function apagarCalisto(lista) {
  let n = 0; const falhou = [];
  for (const x of lista) { try { await api(`/playlists/${x.id}/followers`, { method: 'DELETE' }); n++; } catch (e) { if (e.status === 404) n++; else falhou.push(x.nome); } }
  const ids = new Set(lista.map(x => x.id));
  for (const p of app.state().pls) if (p.spotify && ids.has(p.spotify.id)) delete p.spotify;
  app.save(); app.redraw(); return { n, falhou };
}
async function vincular(s) { /* usado de fora */ if (!(await pronto(null))) return; escolher(null, s); }
window.calistoSpotify = { create, conferir, vincular, listarCalisto, apagarCalisto, pronto, connected: () => !!tok, connect: () => connect(null), disconnect: () => { keep(tok = null); app.redraw(); } };
app.redraw();
