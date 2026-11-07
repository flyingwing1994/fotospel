// Spelersapp
'use strict';
const S = {
  state: null, fetchedAt: 0, board: null, feed: null, tab: 'cards', sheet: null, // sheet: { assignmentId }
  photo: null,     // { full, thumb, url } gekozen maar nog niet verstuurd
  busy: false, feedFilter: 'all',
};
const app = $('#app');

// ---------- opstart ----------
async function boot() {
  let me;
  try { me = await api('GET', '/api/me'); } catch (e) { app.innerHTML = `<div class="center-screen"><p class="error">${esc(e.message)}</p></div>`; return; }
  if (!me.player) return renderJoin();
  await reload();
  liveUpdates(reload);
  setInterval(tick, 1000);
}

function renderJoin(error = '') {
  const code = new URLSearchParams(location.search).get('code') || '';
  app.innerHTML = `
  <div class="center-screen"><div class="panel">
    <div class="logo">📸</div>
    <h1>Fotospel</h1>
    <p class="muted">Vul de teamcode in die je van de organisatie hebt gekregen, en je naam.</p>
    <form id="join">
      <label class="field"><span>Teamcode</span>
        <input class="code" name="code" type="text" maxlength="8" autocomplete="off" autocapitalize="characters" value="${esc(code)}" required></label>
      <label class="field"><span>Je naam</span>
        <input name="name" type="text" maxlength="30" autocomplete="given-name" required></label>
      <p class="error">${esc(error)}</p>
      <button class="btn block" type="submit">Meedoen</button>
    </form>
  </div></div>`;
  $('#join').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const btn = $('button', ev.target);
    btn.disabled = true;
    try {
      await api('POST', '/api/join', { code: f.get('code'), name: f.get('name') });
      history.replaceState(null, '', '/');
      boot();
    } catch (e) { renderJoin(e.message); }
  };
}

let reloading = false, reloadAgain = false;
async function reload() {
  if (reloading) { reloadAgain = true; return; }
  reloading = true;
  try {
    const [state, board] = await Promise.all([api('GET', '/api/state'), api('GET', '/api/scoreboard')]);
    S.state = state; S.board = board; S.fetchedAt = Date.now();
    checkChanges(state, board);
    if (state.game.status === 'revealed') {
      try { S.feed = await api('GET', '/api/feed'); } catch { S.feed = null; }
    } else if (S.tab === 'feed') S.tab = 'cards';
    render();
  } catch (e) {
    if (e.status === 401) { renderJoin('Je bent uitgelogd. Log opnieuw in.'); return; }
    toast(e.message, true);
  } finally {
    reloading = false;
    if (reloadAgain) { reloadAgain = false; reload(); }
  }
}

// ---------- hulpjes ----------
function findAssignment(id) {
  for (const r of S.state.rounds) for (const a of r.assignments || []) if (a.id === id) return a;
  return null;
}
function activeMs(card) {
  return card.activeMs + (card.running ? Date.now() - S.fetchedAt : 0);
}
function pointsNow(a) {
  const ms = a.card ? activeMs(a.card) : 0;
  return Scoring.calcPoints(ms, { base_points: a.basePoints, decay_per_min: a.decayPerMin, floor_points: a.floorPoints }, S.state.game.freeMinutes);
}
function myTotal() {
  const t = S.board?.teams.find((x) => x.id === S.state.team.id);
  return t ? t.total : 0;
}
function chip(cat) {
  if (!cat) return '';
  return `<span class="chip"><i style="background:${safeColor(cat.color)}"></i>${esc(cat.name)}</span>`;
}
function clockText(a) {
  const ms = activeMs(a.card);
  const left = Scoring.fullPointsLeftMs(ms, S.state.game.freeMinutes);
  if (left > 0) return `volle punten nog ${fmtDuration(left)}`;
  const floorAt = Scoring.floorReachedAtMs({ base_points: a.basePoints, decay_per_min: a.decayPerMin, floor_points: a.floorPoints }, S.state.game.freeMinutes);
  if (ms >= floorAt) return 'minimum bereikt';
  return `−${a.decayPerMin} pt per minuut`;
}

// ---------- weergave ----------
function render() {
  const st = S.state;
  const revealed = st.game.status === 'revealed';
  const pending = st.rounds.flatMap((r) => r.assignments || []).filter((a) => a.card && a.card.status === 'submitted').length;
  app.innerHTML = `
  <div class="offline hidden" id="offline">Geen live verbinding, opnieuw verbinden…</div>
  <header class="top"><div class="wrap">
    <div class="top-row">
      <div class="grow"><div class="team-name">${esc(st.team.name)}</div>
        <div class="small muted">${st.team.members.map(esc).join(', ')}</div></div>
      <div class="score-pill">${myTotal()} pt</div>
    </div>
    <nav class="tabs">
      <button data-tab="cards" class="${S.tab === 'cards' ? 'on' : ''}">Kaartjes${pending ? `<span class="badge">${pending}</span>` : ''}</button>
      <button data-tab="board" class="${S.tab === 'board' ? 'on' : ''}">Scorebord</button>
      ${revealed ? `<button data-tab="feed" class="${S.tab === 'feed' ? 'on' : ''}">Feed</button>` : ''}
    </nav>
  </div></header>
  <main class="wrap" id="main">${S.tab === 'board' ? boardHtml() : S.tab === 'feed' ? feedHtml() : cardsHtml()}</main>
  <div id="sheet-host"></div>`;
  $$('.tabs button').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); });
  bindMain();
  renderSheet();
}
setInterval(() => { const o = $('#offline'); if (o) o.classList.toggle('hidden', !document.body.classList.contains('is-offline')); }, 1000);

function statusNotice() {
  const g = S.state.game;
  if (g.status === 'setup') return `<div class="notice">Het spel is nog niet begonnen. Zodra de eerste ronde vrijkomt, verschijnen hier de kaartjes.</div>`;
  if (g.status === 'ended') return `<div class="notice warn"><b>Het spel is afgelopen.</b> Uploaden kan niet meer. Wacht op de onthulling van alle foto's.</div>`;
  if (g.status === 'revealed') return `<div class="notice good"><b>Onthuld!</b> Bekijk alle foto's in de feed.</div>`;
  let s = `<div class="notice small">Open kaartjes: <b>${S.state.openCount} van ${g.maxOpen}</b>. Na openen heb je ${g.freeMinutes} minuten voor de volle punten.`;
  if (g.endTime) s += ` Het spel eindigt om <b>${fmtTime(g.endTime)}</b>.`;
  s += '</div>';
  if (S.state.retryOpen) s += `<div class="notice bad">Je hebt een herkansing openstaan. Lever die eerst in; tot die tijd kun je geen nieuw kaartje openen.</div>`;
  return s;
}

function tileHtml(a) {
  const c = a.card;
  const bonus = a.firstBonus > 0 ? `<span class="small muted">+${a.firstBonus} eerste team</span>` : '';
  if (!c) {
    return `<button class="tile closed-card" data-a="${a.id}">${chip(a.category)}
      <div class="pts">${a.basePoints}<small>pt</small></div>${bonus}
      <div class="state muted">Dicht</div></button>`;
  }
  const title = `<div class="title">${esc(a.title)}</div>`;
  switch (c.status) {
    case 'open':
      return `<button class="tile open" data-a="${a.id}">${chip(a.category)}${title}
        <div class="pts" data-live-pts="${a.id}">${pointsNow(a)}<small>pt</small></div>
        <div class="state c-accent" data-live-clock="${a.id}">${clockText(a)}</div></button>`;
    case 'rejected':
      return `<button class="tile retry" data-a="${a.id}">${chip(a.category)}${title}
        <div class="pts" data-live-pts="${a.id}">${pointsNow(a)}<small>pt</small></div>
        <div class="state c-bad">Herkansing</div></button>`;
    case 'submitted':
      return `<button class="tile" data-a="${a.id}">${title}${c.photo ? `<img class="thumb" src="${esc(c.photo)}" alt="">` : ''}
        <div class="state c-warn">In beoordeling…</div></button>`;
    case 'approved':
      return `<button class="tile done" data-a="${a.id}">${title}${c.photo ? `<img class="thumb" src="${esc(c.photo)}" alt="">` : ''}
        <div class="state c-good">✓ ${c.points} pt${c.firstBonus ? ` +${a.firstBonus} eerste` : ''}</div></button>`;
    case 'final_rejected':
      return `<button class="tile gone" data-a="${a.id}">${title}<div class="state c-bad">Afgekeurd · 0 pt</div></button>`;
    case 'closed':
      return `<button class="tile gone" data-a="${a.id}">${title}<div class="state muted">Gesloten</div></button>`;
    default: return '';
  }
}

function cardsHtml() {
  const st = S.state;
  let html = statusNotice();
  if (!st.rounds.length && st.game.status !== 'setup') html += `<p class="muted">Er zijn nog geen rondes.</p>`;
  for (const r of st.rounds) {
    if (!r.released) {
      html += `<div class="round-head"><h2>${esc(r.name)}</h2></div>
        <div class="locked-round">🔒 Nog niet vrijgegeven${r.releaseAt ? ` · komt om ${fmtTime(r.releaseAt)}` : ''}</div>`;
      continue;
    }
    html += `<div class="round-head"><h2>${esc(r.name)}</h2><span class="small muted">${r.assignments.length} kaartjes</span></div>
      <div class="grid">${r.assignments.map(tileHtml).join('')}</div>`;
  }
  html += `<p style="margin-top:40px" class="small muted center">Ingelogd als ${esc(st.me.name)} · <a href="#" id="logout">uitloggen op dit toestel</a></p>`;
  return html;
}

function boardHtml() {
  const b = S.board;
  const me = S.state.team.id;
  let html = `<h2>Stand</h2><ol class="board">${b.teams.map((t, i) => `
    <li class="${t.id === me ? 'me' : ''}"><span class="pos">${i + 1}</span>
      <span class="nm">${esc(t.name)}<small>${t.done} ${t.done === 1 ? 'foto' : "foto's"} · ${t.photoPoints} + ${t.bonusPoints} bonus</small></span>
      <span class="tot">${t.total}</span></li>`).join('')}</ol>`;
  const cats = b.categories.filter((c) => c.teams.some((t) => t.points > 0));
  if (b.categories.length) {
    html += `<h2>Per categorie</h2>`;
    if (!cats.length) html += `<p class="muted small">Nog geen goedgekeurde foto's.</p>`;
    for (const c of cats) {
      const max = Math.max(1, ...c.teams.map((t) => t.points));
      html += `<div class="panel cat-block"><h3>${chip(c)}</h3>${c.teams.filter((t) => t.points > 0).map((t) => `
        <div class="bar-row"><span class="n">${t.teamId === me ? '<b>' + esc(t.name) + '</b>' : esc(t.name)}</span>
        <span class="bar"><i style="width:${(t.points / max) * 100}%;background:${safeColor(c.color)}"></i></span>
        <span class="v">${t.points}</span></div>`).join('')}</div>`;
    }
  }
  if (b.bonuses.length) {
    html += `<h2>Laatste bonussen</h2><ul class="board">${b.bonuses.map((x) => `<li><span class="nm">${esc(x.team)}<small>${esc(x.description)}</small></span>
      <span class="tot ${x.points < 0 ? 'c-bad' : 'c-good'}">${x.points > 0 ? '+' : ''}${x.points}</span></li>`).join('')}</ul>`;
  }
  return html;
}

function feedHtml() {
  if (!S.feed) return `<p class="muted">Feed laden…</p>`;
  const cats = new Map(S.feed.categories.map((c) => [c.id, c]));
  const filters = [['all', 'Alles'], ...S.feed.categories.map((c) => ['c' + c.id, c.name]),
    ...[...new Set(S.feed.items.map((i) => i.team))].map((t) => ['t' + t, t])];
  const items = S.feed.items.filter((i) => S.feedFilter === 'all' || S.feedFilter === 'c' + i.categoryId || S.feedFilter === 't' + i.team);
  return `<h2>Alle foto's</h2>
    <div class="feed-filter">${filters.map(([k, l]) => `<button data-f="${esc(k)}" class="${S.feedFilter === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
    ${items.length ? '' : '<p class="muted">Geen foto\'s.</p>'}
    <div class="feed">${items.map((i) => `<figure data-full="/photos/${i.id}/full?v=${esc(i.v)}" data-cap="${esc(i.title + ' · ' + i.team + ' · ' + i.points + ' pt')}">
      <img loading="lazy" src="/photos/${i.id}/thumb?v=${esc(i.v)}" alt="">
      <figcaption><b>${esc(i.title)}</b><br><span class="muted">${esc(i.team)}</span> ${chip(cats.get(i.categoryId))}</figcaption></figure>`).join('')}</div>`;
}

function bindMain() {
  $$('.tile').forEach((t) => t.onclick = () => openSheet(Number(t.dataset.a)));
  $$('.feed figure').forEach((f) => f.onclick = () => lightbox(f.dataset.full, f.dataset.cap));
  $$('.feed-filter button').forEach((b) => b.onclick = () => { S.feedFilter = b.dataset.f; render(); });
  const lo = $('#logout');
  if (lo) lo.onclick = async (e) => {
    e.preventDefault();
    if (!confirm('Uitloggen op dit toestel? Je kunt daarna opnieuw meedoen met dezelfde code en naam.')) return;
    await api('POST', '/api/logout'); location.reload();
  };
}

// ---------- kaartje-venster ----------
function openSheet(assignmentId) {
  if (S.sheet?.assignmentId !== assignmentId) clearPhoto();
  S.sheet = { assignmentId };
  renderSheet();
}
function closeSheet() { S.sheet = null; clearPhoto(); renderSheet(); }
function clearPhoto() { if (S.photo?.url) URL.revokeObjectURL(S.photo.url); S.photo = null; }

function renderSheet() {
  const host = $('#sheet-host');
  if (!host) return;
  if (!S.sheet) { host.innerHTML = ''; return; }
  const a = findAssignment(S.sheet.assignmentId);
  if (!a) { S.sheet = null; host.innerHTML = ''; return; }
  const g = S.state.game;
  const running = g.status === 'running';
  const c = a.card;
  let body = '';

  if (!c) {
    const blocked = S.state.retryOpen ? 'Je hebt een herkansing openstaan. Lever die eerst in.'
      : S.state.openCount >= g.maxOpen ? `Je hebt al ${g.maxOpen} open kaartjes. Sluit er eerst een (dat kaartje ben je dan kwijt) of lever een foto in.`
      : !running ? 'Het spel is niet bezig.' : '';
    body = `<h2 style="margin-top:0">Kaartje openen?</h2>${chip(a.category)}
      <div class="clock"><div><span class="small muted">Waard</span><b>${a.basePoints} pt</b></div>
        <div><span class="small muted">Eerste team</span><b>${a.firstBonus > 0 ? '+' + a.firstBonus : '–'}</b></div></div>
      <p>Na openen zie je de opdracht en start jullie klok. Binnen <b>${g.freeMinutes} minuten</b> krijg je de volle punten,
        daarna gaat er ${a.decayPerMin} punt per minuut af, tot minimaal ${a.floorPoints}.</p>
      <p class="small muted">Open kaartjes: ${S.state.openCount} van ${g.maxOpen}.</p>
      ${blocked ? `<div class="notice warn">${esc(blocked)}</div>` : ''}
      <button class="btn block" id="do-open" ${blocked ? 'disabled' : ''}>Open kaartje</button>`;
  } else {
    body = `<h2 style="margin-top:0">${esc(a.title)}</h2>${chip(a.category)}
      <div class="task-text">${esc(a.text)}</div>`;
    if (c.running) {
      body += `<div class="clock"><div><span class="small muted">Nu waard</span><b data-live-pts="${a.id}">${pointsNow(a)} pt</b></div>
        <div><span class="small muted">Klok</span><b style="font-size:1.05rem" data-live-clock="${a.id}">${clockText(a)}</b></div></div>`;
      if (c.status === 'rejected') body += `<div class="notice bad"><b>Afgekeurd:</b> ${esc(c.reason)}<br>Dit is je herkansing, je laatste poging. De klok loopt verder.</div>`;
      if (!running) body += `<div class="notice warn">Het spel is afgelopen; je kunt niets meer insturen.</div>`;
      else body += photoPickerHtml();
      if (running && !S.photo) body += `<button class="btn ghost block" id="do-close" style="margin-top:22px">Kaartje sluiten (ben je kwijt)</button>`;
    } else if (c.status === 'submitted') {
      body += `${c.photo ? `<img class="preview" src="${esc(c.photo)}" alt="">` : ''}
        <div class="notice warn">In beoordeling. Jullie klok staat stil tot een beheerder heeft gekeken.</div>`;
    } else if (c.status === 'approved') {
      body += `${c.photo ? `<img class="preview" src="${esc(c.photo)}" alt="">` : ''}
        <div class="notice good"><b>Goedgekeurd: ${c.points} punten</b>${c.firstBonus ? ` + ${a.firstBonus} als eerste team` : ''}.</div>`;
    } else if (c.status === 'final_rejected') {
      body += `<div class="notice bad"><b>Definitief afgekeurd:</b> ${esc(c.reason || '')}<br>Dit kaartje levert geen punten op.</div>`;
    } else if (c.status === 'closed') {
      body += `<div class="notice">Dit kaartje hebben jullie gesloten.</div>`;
    }
  }
  host.innerHTML = `<div class="sheet-back" id="sheet-back"><div class="sheet" role="dialog" aria-modal="true">
    <button class="close-x" id="sheet-x" aria-label="Sluiten">×</button>${body}</div></div>`;
  $('#sheet-back').onclick = (e) => { if (e.target.id === 'sheet-back' && !S.busy) closeSheet(); };
  $('#sheet-x').onclick = () => { if (!S.busy) closeSheet(); };
  bindSheet(a);
}

function photoPickerHtml() {
  if (S.photo) {
    return `<img class="preview" src="${esc(S.photo.url)}" alt="Voorbeeld">
      <div class="progress hidden" id="prog"><i></i></div>
      <div class="row"><button class="btn secondary" id="re-pick" ${S.busy ? 'disabled' : ''}>Andere foto</button>
      <button class="btn good" id="do-send" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Versturen…' : 'Versturen'}</button></div>
      <p class="small muted">Je kunt maar één foto per poging insturen. Controleer of hij goed is.</p>`;
  }
  return `<input type="file" accept="image/*" capture="environment" id="in-cam" class="hidden">
    <input type="file" accept="image/*" id="in-lib" class="hidden">
    <div class="row"><button class="btn" id="pick-cam">📷 Maak foto</button>
    <button class="btn secondary" id="pick-lib">Kies uit galerij</button></div>
    <p class="small muted" id="pick-msg"></p>`;
}

function bindSheet(a) {
  const open = $('#do-open');
  if (open) open.onclick = async () => {
    open.disabled = true;
    try { await api('POST', '/api/cards', { assignmentId: a.id }); await reload(); }
    catch (e) { toast(e.message, true); open.disabled = false; }
  };
  const close = $('#do-close');
  if (close) close.onclick = async () => {
    if (!confirm('Weet je het zeker? Dit kaartje is dan voorgoed weg voor jullie team.')) return;
    try { await api('POST', `/api/cards/${a.card.id}/close`); if (S.snap) S.snap.cards[a.id] = 'closed'; closeSheet(); await reload(); }
    catch (e) { toast(e.message, true); }
  };
  const cam = $('#in-cam'), lib = $('#in-lib');
  if ($('#pick-cam')) $('#pick-cam').onclick = () => cam.click();
  if ($('#pick-lib')) $('#pick-lib').onclick = () => lib.click();
  for (const input of [cam, lib]) if (input) input.onchange = () => input.files[0] && choosePhoto(input.files[0]);
  if ($('#re-pick')) $('#re-pick').onclick = () => { clearPhoto(); renderSheet(); };
  if ($('#do-send')) $('#do-send').onclick = () => sendPhoto(a);
}

async function choosePhoto(file) {
  const msg = $('#pick-msg');
  if (msg) msg.textContent = 'Foto verwerken…';
  try {
    const img = await loadImage(file);
    const full = await toJpeg(img, 2000, 0.85);
    const thumb = await toJpeg(img, 480, 0.75);
    clearPhoto();
    S.photo = { full, thumb, url: URL.createObjectURL(full) };
    renderSheet();
  } catch (e) {
    if (msg) msg.textContent = e.message || 'Deze foto kon niet gelezen worden. Probeer een andere.';
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Deze foto kon niet gelezen worden. Probeer een andere.')); };
    img.src = url;
  });
}
function toJpeg(img, max, quality) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const scale = Math.min(1, max / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * scale); canvas.height = Math.round(h0 * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Foto verwerken mislukt')), 'image/jpeg', quality));
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Foto lezen mislukt'));
    r.readAsDataURL(blob);
  });
}

async function sendPhoto(a) {
  if (S.busy || !S.photo) return;
  S.busy = true; renderSheet();
  const prog = $('#prog');
  prog?.classList.remove('hidden');
  try {
    const body = JSON.stringify({ full: await blobToBase64(S.photo.full), thumb: await blobToBase64(S.photo.thumb) });
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/cards/${a.card.id}/photo`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.upload.onprogress = (e) => { const p = $('#prog > i'); if (p && e.lengthComputable) p.style.width = (e.loaded / e.total) * 100 + '%'; };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        xhr.status < 300 ? resolve() : reject(new Error(data.error || `Fout ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Versturen mislukt, geen verbinding. Probeer het opnieuw.'));
      xhr.send(body);
    });
    clearPhoto();
    toast('Foto verstuurd!');
    S.busy = false;
    await reload();
  } catch (e) {
    S.busy = false;
    toast(e.message, true);
    renderSheet();
  }
}

// ---------- meldingen ----------
// Vergelijkt de nieuwe stand met wat deze speler al gezien heeft (ook na het sluiten van de app).
function snapshot(state, board, warned) {
  const cards = {};
  for (const r of state.rounds) for (const a of r.assignments || []) if (a.card) cards[a.id] = a.card.status;
  return {
    status: state.game.status,
    rounds: state.rounds.filter((r) => r.released).map((r) => r.id),
    cards,
    bonuses: board.bonuses.filter((b) => b.teamId === state.team.id).map((b) => b.id),
    warned: warned || {},
  };
}
function checkChanges(state, board) {
  const key = 'fotospel-seen-' + state.me.id;
  const prev = S.snap || loadJson(key);
  const next = snapshot(state, board, prev?.warned);
  S.snap = next;
  saveJson(key, next);
  if (!prev) return; // eerste keer: niets melden
  const g = state.game.status;
  if (prev.status !== g) {
    if (g === 'running' && prev.status === 'setup') notify('Het spel is begonnen!', 'good');
    if (g === 'running' && prev.status !== 'setup') notify('Het spel is weer geopend.', 'good');
    if (g === 'ended') notify('Het spel is afgelopen. Insturen kan niet meer.', 'warn', true);
    if (g === 'revealed') notify('Alle foto\'s zijn onthuld! Bekijk ze in de feed.', 'good', true);
  }
  for (const r of state.rounds) {
    if (r.released && !prev.rounds.includes(r.id)) notify(`Nieuwe ronde: ${r.name}, met ${r.assignments.length} ${r.assignments.length === 1 ? 'kaartje' : 'kaartjes'}`, 'good', true);
  }
  for (const r of state.rounds) for (const a of r.assignments || []) {
    const c = a.card;
    if (!c) continue;
    const was = prev.cards[a.id];
    if (was === c.status) continue;
    if (!was && c.openedBy && c.openedBy !== 'jij') notify(`${c.openedBy} heeft "${a.title}" geopend`);
    if (c.status === 'submitted' && c.uploadedBy && c.uploadedBy !== 'jij') notify(`${c.uploadedBy} heeft de foto voor "${a.title}" ingestuurd`);
    if (c.status === 'approved') notify(`Goedgekeurd: "${a.title}", ${c.points} punten${c.firstBonus ? ` + ${a.firstBonus} als eerste team` : ''}`, 'good', true);
    if (c.status === 'rejected') notify(`Afgekeurd: "${a.title}". ${c.reason || ''} Je hebt nog één poging, de klok loopt weer.`, 'bad', true);
    if (c.status === 'final_rejected') notify(`Definitief afgekeurd: "${a.title}". ${c.reason || ''}`, 'bad', true);
    if (c.status === 'closed' && was && was !== 'closed') notify(`"${a.title}" is gesloten`);
  }
  for (const b of board.bonuses) {
    if (b.teamId !== state.team.id || prev.bonuses.includes(b.id) || b.description.startsWith('Eerste team:')) continue;
    notify(b.points > 0 ? `+${b.points} bonus: ${b.description}` : `${b.points} strafpunten: ${b.description}`, b.points > 0 ? 'good' : 'bad', true);
  }
}
function remember(flag) {
  if (!S.snap) return false;
  if (S.snap.warned[flag]) return false;
  S.snap.warned[flag] = true;
  saveJson('fotospel-seen-' + S.state.me.id, S.snap);
  return true;
}
function timerWarnings() {
  const g = S.state.game;
  if (g.status !== 'running') return;
  const serverNow = S.state.serverNow + (Date.now() - S.fetchedAt);
  if (g.endTime) {
    const left = g.endTime - serverNow;
    if (left > 0 && left <= 10 * 60000 && remember('end10-' + g.endTime)) notify(`Nog 10 minuten: het spel eindigt om ${fmtTime(g.endTime)}`, 'warn', true);
    if (left > 0 && left <= 2 * 60000 && remember('end2-' + g.endTime)) notify('Nog 2 minuten! Stuur je laatste foto\'s in.', 'warn', true);
  }
  for (const r of S.state.rounds) for (const a of r.assignments || []) {
    if (!a.card?.running) continue;
    const full = Scoring.fullPointsLeftMs(activeMs(a.card), g.freeMinutes);
    if (full > 0 && full <= 60000 && remember('free-' + a.card.id + '-' + a.card.attempts)) notify(`Nog 1 minuut volle punten voor "${a.title}"`, 'warn');
  }
}

// ---------- elke seconde de klokken bijwerken ----------
function tick() {
  if (!S.state) return;
  timerWarnings();
  for (const el of $$('[data-live-pts]')) {
    const a = findAssignment(Number(el.dataset.livePts));
    if (a?.card) el.innerHTML = el.tagName === 'B' ? `${pointsNow(a)} pt` : `${pointsNow(a)}<small>pt</small>`;
  }
  for (const el of $$('[data-live-clock]')) {
    const a = findAssignment(Number(el.dataset.liveClock));
    if (a?.card) el.textContent = clockText(a);
  }
}

boot();
