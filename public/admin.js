// Beheerapp
'use strict';
const A = { s: null, me: null, tab: 'review', dirty: false, stale: false, open: new Set(), feedFilter: 'all', flash: null, drafts: {} };
const app = $('#app');
const TABS = [['review', 'Beoordelen'], ['game', 'Spel'], ['tasks', 'Opdrachten'], ['teams', 'Teams'], ['bonus', 'Bonus'], ['score', 'Score'], ['feed', 'Feed']];
const QUICK_REASONS = ['Niet alle teamleden staan erop', 'Opdracht niet (goed) uitgevoerd', 'Foto is onduidelijk of te donker', 'Foto past niet bij deze opdracht'];
const STATUS_NL = { setup: 'Voorbereiding', running: 'Bezig', ended: 'Afgelopen', revealed: 'Onthuld' };

async function boot() {
  const r = await api('GET', '/api/admin/me').catch(() => ({}));
  if (!r.admin) return renderLogin();
  A.me = r.admin;
  if (location.hash.slice(1) && TABS.some(([k]) => k === location.hash.slice(1))) A.tab = location.hash.slice(1);
  await reload(true);
  liveUpdates(() => reload(false));
}

function renderLogin(error = '') {
  app.innerHTML = `<div class="center-screen"><div class="panel">
    <h1>Beheer</h1><p class="muted">Fotospel</p>
    <form id="login">
      <label class="field"><span>Naam</span><input name="name" type="text" autocomplete="username" required></label>
      <label class="field"><span>Wachtwoord</span><input name="password" type="password" autocomplete="current-password" required></label>
      <p class="error">${esc(error)}</p>
      <button class="btn block">Inloggen</button>
    </form></div></div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('POST', '/api/admin/login', { name: f.get('name'), password: f.get('password') }); boot(); }
    catch (err) { renderLogin(err.message); }
  };
}

let loading = false, again = false;
async function reload(force) {
  if (loading) { again = true; return; }
  loading = true;
  try {
    const s = await api('GET', '/api/admin/state');
    adminChanges(A.s, s);
    const inQueue = new Set(s.queue.map((q) => String(q.id)));
    for (const id of Object.keys(A.drafts)) if (!inQueue.has(id)) delete A.drafts[id];
    A.s = s;
    A.loadedAt = Date.now();
    if (A.tab === 'feed') A.feed = await api('GET', '/api/feed');
    if (A.dirty && !force) { A.stale = true; renderStaleBar(); }
    else render();
  } catch (e) {
    if (e.status === 401) return renderLogin('Sessie verlopen, log opnieuw in.');
    toast(e.message, true);
  } finally {
    loading = false;
    if (again) { again = false; reload(force); }
  }
}

// meldingen voor beheerders: nieuwe foto's, automatisch vrijgegeven rondes, einde nadert
const warnedAdmin = new Set();
function adminChanges(prev, next) {
  document.title = next.queue.length ? `(${next.queue.length}) Fotospel · Beheer` : 'Fotospel · Beheer';
  if (!prev) return;
  const known = new Set(prev.queue.map((q) => q.id));
  for (const q of next.queue) {
    if (known.has(q.id) || q.ownTeam) continue;
    notify(q.attempt === 2 ? `Herkansing van ${q.team}: "${q.title}"` : `Nieuwe foto van ${q.team}: "${q.title}"`, q.attempt === 2 ? 'warn' : '');
  }
  for (const r of next.rounds) {
    const was = prev.rounds.find((x) => x.id === r.id);
    if (was && !was.released && r.released && !r.released_at) notify(`${r.name} is automatisch vrijgegeven`, 'good');
  }
  if (prev.game.effectiveStatus === 'running' && next.game.effectiveStatus === 'ended') notify('Het spel is afgelopen. Beoordeel de laatste foto\'s en onthul daarna de feed.', 'warn', true);
}
setInterval(() => {
  const g = A.s?.game;
  if (!g || g.effectiveStatus !== 'running' || !g.endTime) return;
  const left = g.endTime - (A.s.serverNow + (Date.now() - A.loadedAt));
  if (left > 0 && left <= 10 * 60000 && !warnedAdmin.has('10-' + g.endTime)) { warnedAdmin.add('10-' + g.endTime); notify(`Het spel eindigt over 10 minuten (${fmtTime(g.endTime)})`, 'warn'); }
}, 5000);

// voer een actie uit, toon fout of melding, en herlaad
async function act(method, url, body, okMsg) {
  try {
    const r = await api(method, url, body);
    A.dirty = false;
    if (okMsg) toast(okMsg);
    await reload(true);
    return r;
  } catch (e) { toast(e.message, true); return null; }
}

const toLocalInput = (ms) => ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const fromLocalInput = (v) => v ? new Date(v).getTime() : null;
const catMap = () => new Map(A.s.categories.map((c) => [c.id, c]));
function chip(cat) { return cat ? `<span class="chip"><i style="background:${safeColor(cat.color)}"></i>${esc(cat.name)}</span>` : ''; }
function minutes(ms) { const m = ms / 60000; return m < 1 ? '<1 min' : `${m.toFixed(1).replace('.', ',')} min`; }

// ---------- weergave ----------
function render() {
  A.stale = false;
  const q = A.s.queue.length;
  const st = A.s.game.effectiveStatus;
  app.innerHTML = `
  <div class="offline hidden" id="offline">Geen live verbinding, opnieuw verbinden…</div>
  <header class="top"><div class="wrap">
    <div class="top-row"><div class="grow"><div class="team-name">Beheer</div>
      <div class="small muted">${esc(A.me.name)}${A.s.me.role === 'master' ? ' (master)' : ''}${A.s.me.teamId ? ' · speelt mee' : ''} · spel: <b>${STATUS_NL[st]}</b></div></div>
      <a class="btn sm secondary" href="/" target="_blank">Spelersapp</a></div>
    <nav class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${A.tab === k ? 'on' : ''}">${l}${k === 'review' && q ? `<span class="badge">${q}</span>` : ''}</button>`).join('')}</nav>
  </div></header>
  <div class="wrap dirty-bar hidden" id="stale"><div class="notice warn row" style="align-items:center">
    <span>Er zijn nieuwe gegevens. Je niet-opgeslagen invoer gaat verloren bij vernieuwen.</span>
    <button class="btn sm" id="stale-btn" style="flex:none">Vernieuwen</button></div></div>
  <main class="wrap" id="main">${({ review: reviewHtml, game: gameHtml, tasks: tasksHtml, teams: teamsHtml, bonus: bonusHtml, score: scoreHtml, feed: feedHtml })[A.tab]()}</main>`;
  $$('.tabs button').forEach((b) => b.onclick = async () => {
    if (A.dirty && !confirm('Niet-opgeslagen invoer gaat verloren. Doorgaan?')) return;
    A.dirty = false; A.tab = b.dataset.tab; location.hash = A.tab;
    if (A.tab === 'feed') A.feed = await api('GET', '/api/feed').catch(() => null);
    render(); window.scrollTo(0, 0);
  });
  $('#stale-btn').onclick = () => { A.dirty = false; render(); };
  // open/dicht van uitklapblokken onthouden
  $$('details[data-key]').forEach((d) => {
    if (A.open.has(d.dataset.key)) d.open = true;
    d.ontoggle = () => d.open ? A.open.add(d.dataset.key) : A.open.delete(d.dataset.key);
  });
  $('#main').addEventListener('input', (e) => { if (e.target.closest('form')) A.dirty = true; });
  bind();
}
function renderStaleBar() { $('#stale')?.classList.remove('hidden'); }
setInterval(() => { const o = $('#offline'); if (o) o.classList.toggle('hidden', !document.body.classList.contains('is-offline')); }, 1000);

// --- Beoordelen ---
function reviewHtml() {
  const cats = catMap();
  const assignments = new Map(A.s.assignments.map((a) => [a.id, a]));
  let html = '';
  if (!A.s.queue.length) html += `<div class="notice">Geen foto's om te beoordelen. Nieuwe inzendingen verschijnen hier vanzelf.</div>`;
  else html += `<h2>Te beoordelen (${A.s.queue.length})</h2>`;
  html += `<div class="admin-list">${A.s.queue.map((q) => {
    const a = assignments.get(q.assignmentId);
    const lockedOther = q.lockedById && q.lockedById !== A.me.id;
    return `<div class="panel q-item" data-sub="${q.id}">
      <img src="/photos/${q.id}/thumb?v=${esc(q.v)}" data-full="/photos/${q.id}/full?v=${esc(q.v)}" alt="" class="zoom">
      <div>
        <h3>${esc(q.title)} ${chip(cats.get(q.categoryId))}</h3>
        <p class="small" style="white-space:pre-wrap;margin:0 0 8px">${esc(q.text)}</p>
        <dl class="kv"><dt>Team</dt><dd><b>${esc(q.team)}</b></dd>
          <dt>Poging</dt><dd>${q.attempt === 2 ? '<b class="c-bad">2 (herkansing, laatste)</b>' : '1'}</dd>
          <dt>Ingestuurd</dt><dd>${fmtTime(q.uploadedAt)} · na ${minutes(q.effectiveMs)}</dd>
          <dt>Punten</dt><dd><b>${q.previewPoints}</b> bij goedkeuren${a && a.first_bonus ? ` <span class="muted">(+ eerste-team-bonus als ze de eerste zijn)</span>` : ''}</dd></dl>
        ${lockedOther ? `<div class="notice warn small">${esc(q.lockedBy)} bekijkt deze foto nu.</div>` : ''}
        ${q.ownTeam ? `<div class="notice warn small">Dit is je eigen team. Een andere beheerder moet deze foto beoordelen.</div>` : `
        <div class="q-actions" style="margin-top:10px">
          <details data-key="bonus-${q.id}"><summary class="small muted" style="cursor:pointer">+ bonus of strafpunten</summary>
            <div class="grid2" style="margin-top:8px"><label class="field"><span>Punten (min = straf)</span><input type="number" name="bonusPoints" step="1" value="${esc(draft(q.id).bonusPoints || '')}"></label>
            <label class="field"><span>Omschrijving</span><input type="text" name="bonusText" maxlength="120" placeholder="Origineelste foto" value="${esc(draft(q.id).bonusText || '')}"></label></div>
          </details>
          <div class="row" style="margin-top:8px"><button class="btn good" data-approve="${q.id}">Goedkeuren</button>
            <button class="btn danger" data-reject-toggle="${q.id}">Afkeuren</button></div>
          <div class="${draft(q.id).rejectOpen ? '' : 'hidden'}" data-reject-box="${q.id}" style="margin-top:10px">
            <div class="feed-filter">${QUICK_REASONS.map((r) => `<button type="button" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
            <label class="field"><span>Reden (ziet het team)</span><textarea name="reason" maxlength="300">${esc(draft(q.id).reason || '')}</textarea></label>
            <button class="btn danger block" data-reject="${q.id}">${q.attempt === 1 ? 'Afkeuren, team krijgt herkansing' : 'Definitief afkeuren (0 punten)'}</button>
          </div>
        </div>`}
      </div></div>`;
  }).join('')}</div>`;
  if (A.s.reviewed.length) {
    html += `<h2>Laatst beoordeeld</h2><div class="panel"><table class="simple"><tbody>${A.s.reviewed.map((r) => `
      <tr><td>${fmtTime(r.reviewedAt)}</td><td><b>${esc(r.team)}</b><br>${esc(r.title)}${r.attempt === 2 ? ' (herkansing)' : ''}</td>
      <td>${r.status === 'approved' ? `<span class="c-good">✓ ${r.points}</span>` : `<span class="c-bad">✗</span> <span class="small">${esc(r.reason)}</span>`}
        <br><span class="small muted">${esc(r.reviewedBy)}</span></td>
      <td><button class="btn sm ghost" data-reset="${r.id}">Terugdraaien</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  return html;
}

// wat een beheerder half heeft ingevuld bij een foto, zodat live verversen het niet wist
function draft(id) { return (A.drafts[id] ||= {}); }

// --- Spel ---
function gameHtml() {
  const g = A.s.game;
  const st = g.effectiveStatus;
  const actions = {
    setup: [['start', 'Spel starten', 'btn good']],
    running: [['end', 'Spel nu beëindigen', 'btn danger']],
    ended: [['reveal', 'Feed onthullen', 'btn good'], ['reopen', 'Spel heropenen', 'btn secondary']],
    revealed: [['reopen', 'Spel heropenen', 'btn secondary']],
  }[st];
  return `<h2>Status: ${STATUS_NL[st]}</h2>
  <div class="panel">
    <p class="small muted">${{
      setup: 'Spelers kunnen al inloggen, maar zien nog geen kaartjes. Start het spel en geef daarna een ronde vrij.',
      running: 'Teams kunnen kaartjes openen en foto\'s insturen.',
      ended: 'Uploaden is gestopt. Beoordeel de laatste foto\'s en onthul daarna de feed.',
      revealed: 'Iedereen ziet nu alle goedgekeurde foto\'s in de feed.' }[st]}</p>
    <div class="row">${actions.map(([a, l, c]) => `<button class="${c}" data-game="${a}">${l}</button>`).join('')}</div>
  </div>
  <h2>Instellingen</h2>
  <form class="panel" data-form="settings">
    <div class="grid2">
      <label class="field"><span>Max. open kaartjes per team</span><input type="number" name="maxOpen" min="1" max="50" value="${g.maxOpen}"></label>
      <label class="field"><span>Vrije tijd (minuten volle punten)</span><input type="number" name="freeMinutes" min="0" step="0.5" value="${g.freeMinutes}"></label>
    </div>
    <label class="field"><span>Eindtijd (uploaden stopt automatisch)</span><input type="datetime-local" name="endTime" value="${toLocalInput(g.endTime)}"></label>
    <button class="btn">Opslaan</button>
  </form>
  <h2>Na afloop</h2>
  <div class="panel">
    <p class="small">Alle goedgekeurde foto's in volle grootte plus <code>scores.csv</code>.</p>
    <a class="btn secondary" href="/api/admin/export.zip">Zip downloaden</a>
  </div>
  <details class="panel" data-key="wipe" style="margin-top:14px"><summary class="c-bad">Alles wissen…</summary>
    <form data-form="wipe">
      <p class="small">Verwijdert alle foto's, spelers, kaartjes, scores en bonussen. Download eerst de zip.</p>
      <label class="field"><input type="checkbox" name="teams"> ook de teams verwijderen</label>
      <label class="field"><input type="checkbox" name="assignments"> ook rondes, opdrachten en categorieën verwijderen</label>
      <label class="field"><span>Typ WISSEN</span><input type="text" name="confirm" autocomplete="off"></label>
      <button class="btn danger">Definitief wissen</button>
    </form></details>
  ${adminsHtml()}
  <p style="margin-top:30px"><button class="btn ghost sm" id="logout">Uitloggen</button></p>`;
}

function teamSelect(name, selected) {
  return `<select name="${name}"><option value="">speelt niet mee</option>${A.s.teams.map((t) =>
    `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>speelt in ${esc(t.name)}</option>`).join('')}</select>`;
}
function adminsHtml() {
  const master = A.s.me.role === 'master';
  let html = `<h2>Beheerders</h2>`;
  if (A.flash) html += `<div class="notice good"><b>${esc(A.flash.name)}</b> kan inloggen op <b>${esc(location.origin)}/beheer</b><br>
    Wachtwoord: <span class="code-box">${esc(A.flash.password)}</span><br>
    <span class="small">Stuur dit nu door; het wordt niet nog eens getoond.</span><br>
    <button class="btn sm secondary" id="flash-copy" style="margin-top:8px">Kopiëren</button>
    <button class="btn sm ghost" id="flash-close" style="margin-top:8px">Sluiten</button></div>`;
  html += `<div class="admin-list">${A.s.admins.map((a) => `<div class="panel">
    <div><b>${esc(a.name)}</b>${a.role === 'master' ? ' <span class="chip">master</span>' : ''}${a.id === A.s.me.id ? ' <span class="small muted">(jij)</span>' : ''}</div>
    ${master ? `<form data-form="admin-team" data-id="${a.id}" style="margin-top:8px">${teamSelect('teamId', a.team_id)}</form>`
      : `<div class="small muted" style="margin-top:4px">${a.team ? 'speelt in ' + esc(a.team) : 'speelt niet mee'}</div>`}
    ${master && a.role !== 'master' ? `<div class="row" style="margin-top:8px"><button class="btn sm ghost" data-admin-reset="${a.id}">Nieuw wachtwoord</button>
      <button class="btn sm ghost" data-admin-del="${a.id}">Verwijderen</button></div>` : ''}</div>`).join('')}</div>`;
  if (master) {
    html += `<form data-form="admin-add" class="panel" style="margin-top:12px"><h3>Beheerder toevoegen</h3>
      <div class="grid2"><label class="field"><span>Naam</span><input type="text" name="name" maxlength="60" required></label>
      <label class="field"><span>Speelt mee?</span>${teamSelect('teamId', null)}</label></div>
      <p class="small muted">Wie meespeelt, kan zijn eigen team niet beoordelen en er geen bonus of strafpunten aan geven.</p>
      <button class="btn">Toevoegen</button></form>`;
  } else {
    html += `<p class="small muted">Alleen de master-beheerder kan beheerders toevoegen of verwijderen.</p>`;
  }
  return html;
}

// --- Opdrachten ---
function assignmentForm(a, roundId) {
  const v = a || { title: '', text: '', category_id: null, base_points: 100, decay_per_min: 2, floor_points: 30, first_bonus: 25, sort: '' };
  return `<form data-form="assignment" data-id="${a ? a.id : ''}">
    <label class="field"><span>Titel (kort, zichtbaar na openen)</span><input type="text" name="title" maxlength="80" value="${esc(v.title)}" required></label>
    <label class="field"><span>Opdracht</span><textarea name="text" maxlength="2000">${esc(v.text)}</textarea></label>
    <div class="grid2">
      <label class="field"><span>Categorie</span><select name="categoryId"><option value="">(geen)</option>
        ${A.s.categories.map((c) => `<option value="${c.id}" ${c.id === v.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Ronde</span><select name="roundId">
        ${A.s.rounds.map((r) => `<option value="${r.id}" ${r.id === (a ? a.round_id : roundId) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    </div>
    <div class="grid4">
      <label class="field"><span>Punten</span><input type="number" name="basePoints" min="0" value="${v.base_points}"></label>
      <label class="field"><span>Afname/min</span><input type="number" name="decayPerMin" min="0" step="0.5" value="${v.decay_per_min}"></label>
      <label class="field"><span>Bodem</span><input type="number" name="floorPoints" min="0" value="${v.floor_points}"></label>
      <label class="field"><span>Bonus eerste</span><input type="number" name="firstBonus" min="0" value="${v.first_bonus}"></label>
    </div>
    <label class="field" style="max-width:120px"><span>Volgorde</span><input type="number" name="sort" value="${v.sort}"></label>
    <div class="row"><button class="btn">${a ? 'Opslaan' : 'Opdracht toevoegen'}</button>
      ${a && !a.card_count ? `<button type="button" class="btn ghost" data-del-assignment="${a.id}">Verwijderen</button>` : ''}</div>
    ${a && a.card_count ? `<p class="small muted">Al door ${a.card_count} team(s) geopend. Wijzigen kan; punten van al goedgekeurde foto's veranderen niet.</p>` : ''}
  </form>`;
}

function tasksHtml() {
  const cats = catMap();
  let html = `<h2>Categorieën</h2><div class="panel">`;
  html += A.s.categories.map((c) => `<form data-form="category" data-id="${c.id}" class="row" style="align-items:end;margin-bottom:8px">
      <label class="field" style="flex:3;margin:0"><input type="text" name="name" value="${esc(c.name)}" maxlength="40"></label>
      <label class="field" style="flex:0 0 56px;margin:0"><input type="color" name="color" value="${safeColor(c.color)}" style="width:56px;height:44px;border:0;background:none"></label>
      <button class="btn sm secondary" style="flex:none">Opslaan</button>
      <button type="button" class="btn sm ghost" style="flex:none" data-del-category="${c.id}">×</button></form>`).join('');
  html += `<form data-form="category" class="row" style="align-items:end">
      <label class="field" style="flex:3;margin:0"><input type="text" name="name" placeholder="Nieuwe categorie" maxlength="40"></label>
      <label class="field" style="flex:0 0 56px;margin:0"><input type="color" name="color" value="#7c6cf0" style="width:56px;height:44px;border:0;background:none"></label>
      <button class="btn sm" style="flex:none">Toevoegen</button></form></div>`;

  html += `<h2>Rondes en opdrachten</h2>`;
  for (const r of A.s.rounds) {
    const list = A.s.assignments.filter((a) => a.round_id === r.id);
    const relState = r.released_at ? `<span class="c-good">vrijgegeven om ${fmtTime(r.released_at)}</span>`
      : r.release_at ? (r.released ? `<span class="c-good">vrijgekomen om ${fmtTime(r.release_at)}</span>` : `<span class="c-warn">komt vrij ${fmtDateTime(r.release_at)}</span>`)
      : '<span class="muted">nog niet vrijgegeven</span>';
    html += `<div class="panel" style="margin-bottom:14px">
      <div class="round-head" style="margin-top:0"><h2>${esc(r.name)}</h2><span class="small">${relState}</span></div>
      <div class="row" style="margin-bottom:12px">
        ${r.released_at ? `<button class="btn sm ghost" data-release="${r.id}" data-undo="1">Vrijgave intrekken</button>`
          : `<button class="btn sm good" data-release="${r.id}">Nu vrijgeven</button>`}</div>
      <div class="admin-list">${list.map((a) => `<details class="panel" data-key="a-${a.id}" style="box-shadow:none">
        <summary>${chip(cats.get(a.category_id))} ${esc(a.title)} <span class="muted small">· ${a.base_points} pt${a.card_count ? ` · ${a.card_count}× geopend` : ''}</span></summary>
        ${assignmentForm(a)}</details>`).join('') || '<p class="small muted">Nog geen opdrachten in deze ronde.</p>'}</div>
      <details class="panel" data-key="new-a-${r.id}" style="box-shadow:none;margin-top:10px"><summary class="c-accent">+ Opdracht toevoegen</summary>${assignmentForm(null, r.id)}</details>
      <details data-key="r-${r.id}" style="margin-top:10px"><summary class="small muted" style="cursor:pointer">Ronde bewerken</summary>
        <form data-form="round" data-id="${r.id}" style="margin-top:10px">
          <div class="grid2"><label class="field"><span>Naam</span><input type="text" name="name" value="${esc(r.name)}" maxlength="60"></label>
          <label class="field"><span>Volgorde</span><input type="number" name="sort" value="${r.sort}"></label></div>
          <label class="field"><span>Automatisch vrijgeven op (leeg = handmatig)</span><input type="datetime-local" name="releaseAt" value="${toLocalInput(r.release_at)}"></label>
          <div class="row"><button class="btn sm">Opslaan</button><button type="button" class="btn sm ghost" data-del-round="${r.id}">Ronde verwijderen</button></div>
        </form></details>
    </div>`;
  }
  html += `<form data-form="round" class="panel"><h3>Nieuwe ronde</h3>
    <label class="field"><span>Naam</span><input type="text" name="name" placeholder="Ronde ${A.s.rounds.length + 1}" maxlength="60" required></label>
    <label class="field"><span>Automatisch vrijgeven op (leeg = handmatig)</span><input type="datetime-local" name="releaseAt"></label>
    <button class="btn">Ronde toevoegen</button></form>`;
  return html;
}

// --- Teams ---
function teamsHtml() {
  const base = location.origin + '/?code=';
  let html = `<h2>Teams (${A.s.teams.length})</h2><div class="admin-list">`;
  html += A.s.teams.map((t) => `<div class="panel">
    <form data-form="team" data-id="${t.id}" class="row" style="align-items:end">
      <label class="field" style="flex:3;margin:0"><span>Naam</span><input type="text" name="name" value="${esc(t.name)}" maxlength="40"></label>
      <button class="btn sm secondary" style="flex:none">Opslaan</button></form>
    <p style="margin:12px 0 6px">Code: <span class="code-box">${esc(t.code)}</span></p>
    <div class="row" style="margin-bottom:10px">
      <button class="btn sm secondary" data-copy="${esc(base + t.code)}">Link kopiëren</button>
      <button class="btn sm ghost" data-newcode="${t.id}">Nieuwe code</button>
      ${t.card_count ? '' : `<button class="btn sm ghost" data-del-team="${t.id}">Team verwijderen</button>`}</div>
    <p class="small muted" style="margin:0 0 4px">Spelers (${t.players.length})${t.openCards ? ` · ${t.openCards} open kaartje(s)` : ''}</p>
    ${t.players.map((p) => `<span class="chip" style="margin:0 4px 4px 0">${esc(p.name)} <button data-del-player="${p.id}" title="Verwijderen"
      style="border:0;background:none;cursor:pointer;padding:0 0 0 4px">×</button></span>`).join('') || '<span class="small muted">nog niemand</span>'}
  </div>`).join('');
  html += `</div><form data-form="team" class="panel" style="margin-top:14px"><h3>Nieuw team</h3>
    <label class="field"><span>Teamnaam</span><input type="text" name="name" maxlength="40" required></label>
    <button class="btn">Team aanmaken</button></form>
    <p class="small muted">Stuur elk team zijn link. Met de link staat de code al ingevuld; iedereen vult alleen zijn naam in.</p>`;
  return html;
}

// --- Bonus ---
function bonusHtml() {
  return `<h2>Bonus of strafpunten geven</h2>
  <form data-form="bonus" class="panel">
    <div class="grid2">
      <label class="field"><span>Team</span><select name="teamId" required><option value="">Kies…</option>
        ${A.s.teams.filter((t) => t.id !== A.s.me.teamId).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Bij opdracht (optioneel)</span><select name="assignmentId"><option value="">(geen)</option>
        ${A.s.assignments.map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join('')}</select></label>
    </div>
    <div class="grid2">
      <label class="field"><span>Punten (negatief = straf)</span><input type="number" name="points" required></label>
      <label class="field"><span>Omschrijving (ziet iedereen)</span><input type="text" name="description" maxlength="120" required></label>
    </div>
    <button class="btn">Toekennen</button>
  </form>
  <h2>Alle bonussen</h2>
  <div class="panel"><table class="simple"><tbody>${A.s.bonuses.map((b) => `<tr>
    <td><b>${esc(b.team)}</b><br><span class="small">${esc(b.description)}</span></td>
    <td class="${b.points < 0 ? 'c-bad' : 'c-good'}"><b>${b.points > 0 ? '+' : ''}${b.points}</b></td>
    <td class="small muted">${b.auto ? 'automatisch' : esc(b.admin || '')}<br>${fmtTime(b.created_at)}</td>
    <td>${b.auto ? '' : `<button class="btn sm ghost" data-del-bonus="${b.id}">×</button>`}</td></tr>`).join('') || '<tr><td class="muted">Nog geen bonussen.</td></tr>'}</tbody></table></div>`;
}

// --- Score ---
function scoreHtml() {
  const b = A.s.scoreboard;
  let html = `<h2>Stand</h2><ol class="board">${b.teams.map((t, i) => `<li><span class="pos">${i + 1}</span>
    <span class="nm">${esc(t.name)}<small>${t.done} ${t.done === 1 ? 'foto' : "foto's"} · ${t.photoPoints} + ${t.bonusPoints} bonus</small></span><span class="tot">${t.total}</span></li>`).join('')}</ol>`;
  if (b.categories.length) {
    html += `<h2>Per categorie (fotopunten)</h2>`;
    for (const c of b.categories) {
      const max = Math.max(1, ...c.teams.map((t) => t.points));
      html += `<div class="panel cat-block"><h3>${chip(c)}</h3>${c.teams.map((t) => `<div class="bar-row"><span class="n">${esc(t.name)}</span>
        <span class="bar"><i style="width:${(t.points / max) * 100}%;background:${safeColor(c.color)}"></i></span><span class="v">${t.points}</span></div>`).join('')}</div>`;
    }
  }
  return html;
}

// --- Feed ---
function feedHtml() {
  if (!A.feed) return '<p class="muted">Laden…</p>';
  const cats = new Map(A.feed.categories.map((c) => [c.id, c]));
  const filters = [['all', 'Alles'], ...A.feed.categories.map((c) => ['c' + c.id, c.name]), ...[...new Set(A.feed.items.map((i) => i.team))].map((t) => ['t' + t, t])];
  const items = A.feed.items.filter((i) => A.feedFilter === 'all' || A.feedFilter === 'c' + i.categoryId || A.feedFilter === 't' + i.team);
  return `<h2>Goedgekeurde foto's (${A.feed.items.length})</h2>
    <p class="small muted">Spelers zien deze pas na de onthulling.</p>
    <div class="feed-filter">${filters.map(([k, l]) => `<button data-f="${esc(k)}" class="${A.feedFilter === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
    <div class="feed">${items.map((i) => `<figure data-full="/photos/${i.id}/full?v=${esc(i.v)}" data-cap="${esc(i.title + ' · ' + i.team + ' · ' + i.points + ' pt')}">
      <img loading="lazy" src="/photos/${i.id}/thumb?v=${esc(i.v)}" alt=""><figcaption><b>${esc(i.title)}</b><br><span class="muted">${esc(i.team)}</span> ${chip(cats.get(i.categoryId))}</figcaption></figure>`).join('')}</div>`;
}

// ---------- gebeurtenissen ----------
function formObj(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return o;
}

function bind() {
  const main = $('#main');
  $$('img.zoom', main).forEach((img) => img.onclick = () => lightbox(img.dataset.full, ''));
  $$('.feed figure', main).forEach((f) => f.onclick = () => lightbox(f.dataset.full, f.dataset.cap));
  $$('.feed-filter button[data-f]', main).forEach((b) => b.onclick = () => { A.feedFilter = b.dataset.f; render(); });

  // beoordelen
  $$('.q-item', main).forEach((item) => {
    const id = item.dataset.sub;
    // één keer per foto laten weten dat jij hem bekijkt (niet bij elke tik, dat ververst ieders scherm)
    item.addEventListener('pointerdown', () => {
      if (draft(id).claimed) return;
      draft(id).claimed = true;
      api('POST', `/api/admin/submissions/${id}/claim`).catch(() => {});
    }, { once: true });
  });
  $$('[data-approve]', main).forEach((b) => b.onclick = async () => {
    const box = b.closest('.q-actions');
    const bp = $('[name=bonusPoints]', box).value, bt = $('[name=bonusText]', box).value;
    b.disabled = true;
    const r = await act('POST', `/api/admin/submissions/${b.dataset.approve}/approve`, { bonusPoints: bp || 0, bonusText: bt }, 'Goedgekeurd');
    if (!r) b.disabled = false;
  });
  $$('[data-reject-toggle]', main).forEach((b) => b.onclick = () => {
    const id = b.dataset.rejectToggle;
    const open = $(`[data-reject-box="${id}"]`).classList.toggle('hidden') === false;
    draft(id).rejectOpen = open;
  });
  $$('.q-item', main).forEach((item) => item.addEventListener('input', (e) => {
    const d = draft(item.dataset.sub);
    if (['reason', 'bonusPoints', 'bonusText'].includes(e.target.name)) d[e.target.name] = e.target.value;
  }));
  $$('[data-reason]', main).forEach((b) => b.onclick = () => {
    const ta = $('textarea[name=reason]', b.closest('[data-reject-box]'));
    ta.value = b.dataset.reason; draft(b.closest('[data-reject-box]').dataset.rejectBox).reason = b.dataset.reason;
  });
  $$('[data-reject]', main).forEach((b) => b.onclick = async () => {
    const reason = $('textarea[name=reason]', b.closest('[data-reject-box]')).value.trim();
    if (!reason) return toast('Geef een reden op', true);
    b.disabled = true;
    const r = await act('POST', `/api/admin/submissions/${b.dataset.reject}/reject`, { reason }, 'Afgekeurd');
    if (!r) b.disabled = false;
  });
  $$('[data-reset]', main).forEach((b) => b.onclick = () => {
    if (confirm('Deze beoordeling terugdraaien? De foto komt weer in de wachtrij.')) act('POST', `/api/admin/submissions/${b.dataset.reset}/reset`, {}, 'Teruggedraaid');
  });

  // spel
  $$('[data-game]', main).forEach((b) => b.onclick = () => {
    const a = b.dataset.game;
    const q = { start: 'Het spel starten?', end: 'Het spel nu beëindigen? Teams kunnen dan niets meer insturen.', reveal: 'De feed onthullen voor iedereen?', reopen: 'Het spel heropenen? Teams kunnen dan weer insturen.' }[a];
    if (confirm(q)) act('POST', '/api/admin/game', { action: a }, 'Gedaan');
  });
  if ($('#logout')) $('#logout').onclick = async () => { await api('POST', '/api/admin/logout'); location.reload(); };

  // opdrachten, rondes, categorieën, teams, bonus
  $$('[data-release]', main).forEach((b) => b.onclick = () => {
    const undo = !!b.dataset.undo;
    if (confirm(undo ? 'Vrijgave intrekken? Teams zien de ronde dan weer niet (al geopende kaartjes blijven).' : 'Deze ronde nu vrijgeven voor alle teams?'))
      act('POST', `/api/admin/rounds/${b.dataset.release}/release`, { undo }, undo ? 'Ingetrokken' : 'Vrijgegeven');
  });
  const del = (attr, url, q) => $$(`[data-${attr}]`, main).forEach((b) => b.onclick = () => {
    if (confirm(q)) act('DELETE', url + b.dataset[attr.replace(/-(\w)/g, (_, c) => c.toUpperCase())], undefined, 'Verwijderd');
  });
  del('del-assignment', '/api/admin/assignments/', 'Deze opdracht verwijderen?');
  del('del-round', '/api/admin/rounds/', 'Deze ronde met al haar opdrachten verwijderen?');
  del('del-category', '/api/admin/categories/', 'Deze categorie verwijderen? Opdrachten houden geen categorie.');
  del('del-team', '/api/admin/teams/', 'Dit team verwijderen?');
  del('del-player', '/api/admin/players/', 'Deze speler verwijderen? Die wordt uitgelogd.');
  del('del-bonus', '/api/admin/bonuses/', 'Deze bonus verwijderen?');
  $$('[data-newcode]', main).forEach((b) => b.onclick = () => {
    if (confirm('Nieuwe code maken? De oude code werkt dan niet meer voor nieuwe spelers (wie al binnen is, blijft binnen).')) act('POST', `/api/admin/teams/${b.dataset.newcode}/newcode`, {}, 'Nieuwe code gemaakt');
  });
  $$('[data-copy]', main).forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link gekopieerd'); }
    catch { prompt('Kopieer deze link:', b.dataset.copy); }
  });

  // beheerders
  $$('form[data-form="admin-team"] select', main).forEach((sel) => sel.onchange = () =>
    act('POST', `/api/admin/admins/${sel.form.dataset.id}`, { teamId: sel.value || null }, 'Opgeslagen'));
  $$('[data-admin-reset]', main).forEach((b) => b.onclick = async () => {
    if (!confirm('Nieuw wachtwoord maken? Het oude werkt dan niet meer en deze beheerder wordt uitgelogd.')) return;
    const r = await act('POST', `/api/admin/admins/${b.dataset.adminReset}/reset`, {}, null);
    if (r) { A.flash = { name: r.name, password: r.password }; render(); }
  });
  $$('[data-admin-del]', main).forEach((b) => b.onclick = () => {
    if (confirm('Deze beheerder verwijderen?')) act('DELETE', `/api/admin/admins/${b.dataset.adminDel}`, undefined, 'Verwijderd');
  });
  if ($('#flash-close')) $('#flash-close').onclick = () => { A.flash = null; render(); };
  if ($('#flash-copy')) $('#flash-copy').onclick = async () => {
    const text = `Beheer fotospel: ${location.origin}/beheer\nNaam: ${A.flash.name}\nWachtwoord: ${A.flash.password}`;
    try { await navigator.clipboard.writeText(text); toast('Gekopieerd'); } catch { prompt('Kopieer:', text); }
  };

  $$('form[data-form]', main).forEach((form) => form.onsubmit = async (e) => {
    e.preventDefault();
    const o = formObj(form);
    const id = form.dataset.id ? Number(form.dataset.id) : undefined;
    switch (form.dataset.form) {
      case 'settings':
        return act('POST', '/api/admin/settings', { maxOpen: o.maxOpen, freeMinutes: o.freeMinutes, endTime: fromLocalInput(o.endTime) || 0 }, 'Opgeslagen');
      case 'wipe':
        if (o.confirm !== 'WISSEN') return toast('Typ WISSEN om te bevestigen', true);
        if (!confirm('Echt alles wissen? Dit kan niet ongedaan worden.')) return;
        return act('POST', '/api/admin/wipe', o, 'Gewist');
      case 'category':
        if (!o.name.trim()) return toast('Vul een naam in', true);
        return act('POST', '/api/admin/categories', { id, name: o.name, color: o.color }, 'Opgeslagen');
      case 'round':
        return act('POST', '/api/admin/rounds', { id, name: o.name || form.querySelector('[name=name]').placeholder, sort: o.sort, releaseAt: fromLocalInput(o.releaseAt) }, 'Opgeslagen');
      case 'assignment': {
        const r = await act('POST', '/api/admin/assignments', { id, ...o, sort: o.sort === '' ? 0 : o.sort }, 'Opgeslagen');
        if (r && !id) A.open.delete('new-a-' + o.roundId);
        return r;
      }
      case 'team':
        return act('POST', '/api/admin/teams', { id, name: o.name }, id ? 'Opgeslagen' : 'Team aangemaakt');
      case 'bonus':
        return act('POST', '/api/admin/bonuses', o, 'Toegekend');
      case 'admin-add': {
        const r = await act('POST', '/api/admin/admins', { name: o.name, teamId: o.teamId || null }, null);
        if (r) { A.flash = { name: r.name, password: r.password }; render(); }
        return r;
      }
      case 'admin-team': return null;
    }
  });
}

boot();
