'use strict';
// Volledige spelronde via de API. Start: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { calcPoints } = require('../public/scoring');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fotospel-test-'));
const PORT = 3000 + Math.floor(Math.random() * 2000) + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const PHOTO = fs.readFileSync(path.join(__dirname, 'photo-exif.jpg')).toString('base64');
const THUMB = fs.readFileSync(path.join(__dirname, 'thumb.jpg')).toString('base64');
let srv;

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie();
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  };
}
const db = () => new DatabaseSync(path.join(DATA, 'fotospel.db'));
const MIN = 60000;

test.before(async () => {
  const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT) };
  execFileSync('node', ['--no-warnings', 'scripts/admin.js', 'add', 'Michiel', 'geheimwachtwoord'], { cwd: ROOT, env });
  srv = spawn('node', ['--no-warnings', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.once('data', r));
});
test.after(() => { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('puntberekening volgens het ontwerp', () => {
  const a = { base_points: 100, decay_per_min: 2, floor_points: 30 };
  assert.equal(calcPoints(3 * MIN, a, 5), 100);
  assert.equal(calcPoints(5 * MIN, a, 5), 100);
  assert.equal(calcPoints(12 * MIN, a, 5), 86);   // rekenvoorbeeld 1
  assert.equal(calcPoints(15 * MIN, a, 5), 80);   // rekenvoorbeeld 2 (herkansing)
  assert.equal(calcPoints(90 * MIN, a, 5), 30);   // bodem
  assert.equal(calcPoints(12 * MIN + 20000, a, 5), 85); // afronden naar beneden
});

test('compleet spel', async () => {
  const admin = client(), p1 = client(), p1b = client(), p2 = client();

  // beheerder logt in
  assert.equal((await admin('POST', '/api/admin/login', { name: 'Michiel', password: 'fout' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/login', { name: 'michiel', password: 'geheimwachtwoord' })).status, 200);
  assert.equal((await p1('GET', '/api/admin/state')).status, 401);

  // opzetten
  await admin('POST', '/api/admin/categories', { name: 'Creatief', color: '#ff0000' });
  await admin('POST', '/api/admin/rounds', { name: 'Ronde 1' });
  await admin('POST', '/api/admin/rounds', { name: 'Ronde 2', releaseAt: Date.now() + 3600000 });
  let st = (await admin('GET', '/api/admin/state')).data;
  const cat = st.categories[0].id;
  const [r1, r2] = st.rounds.map((r) => r.id);
  for (let i = 1; i <= 5; i++) {
    const r = await admin('POST', '/api/admin/assignments', { roundId: r1, categoryId: i <= 2 ? cat : '', title: `Opdracht ${i}`, text: `Doe ${i}`,
      basePoints: 100, decayPerMin: 2, floorPoints: 30, firstBonus: 25 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  await admin('POST', '/api/admin/assignments', { roundId: r2, title: 'Later', basePoints: 50, decayPerMin: 1, floorPoints: 10, firstBonus: 0 });
  await admin('POST', '/api/admin/teams', { name: 'De Kaasjes' });
  await admin('POST', '/api/admin/teams', { name: 'Team Zon' });
  st = (await admin('GET', '/api/admin/state')).data;
  const A = st.assignments.map((a) => a.id);
  const [t1, t2] = [st.teams.find((t) => t.name === 'De Kaasjes'), st.teams.find((t) => t.name === 'Team Zon')];
  assert.match(t1.code, /^[A-Z2-9]{6}$/);

  // spelers doen mee
  assert.equal((await p1('POST', '/api/join', { code: 'XXXXXX', name: 'Anna' })).status, 400);
  assert.equal((await p1('POST', '/api/join', { code: t1.code.toLowerCase(), name: 'Anna' })).status, 200);
  assert.equal((await p1b('POST', '/api/join', { code: t1.code, name: 'Bram' })).status, 200);
  assert.equal((await p2('POST', '/api/join', { code: t2.code, name: 'Cas' })).status, 200);
  let s1 = (await p1('GET', '/api/state')).data;
  assert.deepEqual(s1.team.members, ['Anna', 'Bram']);
  assert.equal(s1.rounds.length, 0, 'voor de start geen rondes');

  // start, ronde 1 nog niet vrij
  await admin('POST', '/api/admin/game', { action: 'start' });
  s1 = (await p1('GET', '/api/state')).data;
  assert.equal(s1.rounds[0].released, false);
  assert.equal(s1.rounds[1].released, false);
  assert.ok(s1.rounds[1].releaseAt);
  assert.equal((await p1('POST', '/api/cards', { assignmentId: A[0] })).status, 400);
  await admin('POST', `/api/admin/rounds/${r1}/release`, {});
  s1 = (await p1('GET', '/api/state')).data;
  assert.equal(s1.rounds[0].assignments.length, 5);
  assert.equal(s1.rounds[0].assignments[0].title, undefined, 'dicht kaartje toont geen titel');
  assert.equal(s1.rounds[0].assignments[0].category.name, 'Creatief');

  // max 3 open
  for (const id of A.slice(0, 3)) assert.equal((await p1('POST', '/api/cards', { assignmentId: id })).status, 200);
  const r4 = await p1('POST', '/api/cards', { assignmentId: A[3] });
  assert.equal(r4.status, 400); assert.match(r4.data.error, /3 open kaartjes/);
  assert.equal((await p1b('POST', '/api/cards', { assignmentId: A[0] })).status, 400, 'teamgenoot kan zelfde kaartje niet nog eens openen');
  s1 = (await p1('GET', '/api/state')).data;
  const card = (i) => s1.rounds[0].assignments.find((a) => a.id === A[i]).card;
  assert.equal(card(0).status, 'open');
  assert.equal(s1.rounds[0].assignments[0].title, 'Opdracht 1');

  // sluiten = kwijt, maakt plek vrij
  assert.equal((await p1('POST', `/api/cards/${card(2).id}/close`)).status, 200);
  assert.equal((await p1('POST', '/api/cards', { assignmentId: A[3] })).status, 200);

  // rekenvoorbeeld: open 12 min geleden, upload
  const c0 = card(0).id;
  db().prepare('UPDATE cards SET opened_at = ?, resumed_at = ? WHERE id = ?').run(Date.now() - 12 * MIN + 2000, Date.now() - 12 * MIN + 2000, c0);
  // team 2 opent opdracht 1 ook, en is eerder klaar (upload eerst)
  await p2('POST', '/api/cards', { assignmentId: A[0] });
  const s2 = (await p2('GET', '/api/state')).data;
  const c2 = s2.rounds[0].assignments[0].card.id;
  assert.equal((await p2('POST', `/api/cards/${c2}/photo`, { full: PHOTO, thumb: THUMB })).status, 200);

  const up = await p1('POST', `/api/cards/${c0}/photo`, { full: PHOTO, thumb: THUMB });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal((await p1('POST', `/api/cards/${c0}/photo`, { full: PHOTO, thumb: THUMB })).status, 400, 'niet twee keer insturen');
  s1 = (await p1('GET', '/api/state')).data;
  assert.equal(card(0).status, 'submitted');
  assert.equal(s1.openCount, 2, 'ingediend telt niet als open');

  // metadata is verwijderd
  const subFile = db().prepare('SELECT file FROM submissions WHERE card_id = ?').get(c0).file;
  const stored = fs.readFileSync(path.join(DATA, 'photos', subFile));
  assert.ok(!stored.includes(Buffer.from('GEHEIM')), 'EXIF moet weg zijn');
  assert.equal(stored[0], 0xff); assert.equal(stored[1], 0xd8);

  // privacy: team 2 ziet foto van team 1 niet, team 1 wel
  const sub1 = (await admin('GET', '/api/admin/state')).data.queue.find((q) => q.team === 'De Kaasjes');
  assert.equal((await p2('GET', `/photos/${sub1.id}/thumb`)).status, 403);
  assert.equal((await p1b('GET', `/photos/${sub1.id}/thumb`)).status, 200);
  assert.equal((await p1('GET', '/api/feed')).status, 403);

  // wachttijd in beoordeling telt niet: 10 min later pas afkeuren
  assert.ok(Math.abs(sub1.effectiveMs - 12 * MIN) < 5000);
  assert.equal(sub1.previewPoints, 86);
  assert.equal((await admin('POST', `/api/admin/submissions/${sub1.id}/reject`, { reason: '' })).status, 400, 'reden verplicht');
  assert.equal((await admin('POST', `/api/admin/submissions/${sub1.id}/reject`, { reason: 'Niet iedereen staat erop' })).status, 200);
  s1 = (await p1('GET', '/api/state')).data;
  assert.equal(card(0).status, 'rejected');
  assert.equal(card(0).reason, 'Niet iedereen staat erop');
  assert.ok(s1.retryOpen);
  const blocked = await p1('POST', '/api/cards', { assignmentId: A[4] });
  assert.equal(blocked.status, 400); assert.match(blocked.data.error, /herkansing/);

  // 3 min na afkeuren opnieuw insturen: effectief 15 min = 80 pt
  db().prepare('UPDATE cards SET resumed_at = ? WHERE id = ?').run(Date.now() - 3 * MIN + 2000, c0);
  assert.equal((await p1('POST', `/api/cards/${c0}/photo`, { full: PHOTO, thumb: THUMB })).status, 200);
  st = (await admin('GET', '/api/admin/state')).data;
  const sub1b = st.queue.find((q) => q.team === 'De Kaasjes');
  assert.equal(sub1b.attempt, 2);
  assert.equal(sub1b.previewPoints, 80);
  assert.equal((await p1('POST', '/api/cards', { assignmentId: A[4] })).status, 200, 'na herkansing weer openen');

  // team 1 eerst goedkeuren: krijgt eerste-team-bonus; daarna team 2 (eerder geüpload) -> bonus verhuist
  assert.equal((await admin('POST', `/api/admin/submissions/${sub1b.id}/approve`, { bonusPoints: 10, bonusText: 'Mooiste licht' })).status, 200);
  let board = (await p1('GET', '/api/scoreboard')).data;
  let k = board.teams.find((t) => t.name === 'De Kaasjes');
  assert.equal(k.photoPoints, 80); assert.equal(k.bonusPoints, 35); assert.equal(k.total, 115);
  const sub2 = st.queue.find((q) => q.team === 'Team Zon');
  await admin('POST', `/api/admin/submissions/${sub2.id}/approve`, {});
  board = (await p1('GET', '/api/scoreboard')).data;
  k = board.teams.find((t) => t.name === 'De Kaasjes');
  const z = board.teams.find((t) => t.name === 'Team Zon');
  assert.equal(k.bonusPoints, 10, 'eerste-team-bonus naar Team Zon verhuisd');
  assert.equal(z.total, 100 + 25);
  assert.equal(board.categories[0].teams.find((t) => t.name === 'De Kaasjes').points, 80);

  // strafpunten en terugdraaien
  await admin('POST', '/api/admin/bonuses', { teamId: t2.id, points: -15, description: 'Te laat terug' });
  board = (await p1('GET', '/api/scoreboard')).data;
  assert.equal(board.teams.find((t) => t.name === 'Team Zon').total, 110);
  assert.equal((await admin('POST', `/api/admin/submissions/${sub2.id}/reset`, {})).status, 200);
  board = (await p1('GET', '/api/scoreboard')).data;
  assert.equal(board.teams.find((t) => t.name === 'Team Zon').total, -15);
  assert.equal(board.teams.find((t) => t.name === 'De Kaasjes').bonusPoints, 35, 'bonus terug bij Kaasjes');
  await admin('POST', `/api/admin/submissions/${sub2.id}/approve`, {});

  // tweede afkeuring is definitief
  const c1 = card(1).id;
  await p1('POST', `/api/cards/${c1}/photo`, { full: PHOTO, thumb: THUMB });
  let q = (await admin('GET', '/api/admin/state')).data.queue[0];
  await admin('POST', `/api/admin/submissions/${q.id}/reject`, { reason: 'nee' });
  await p1('POST', `/api/cards/${c1}/photo`, { full: PHOTO, thumb: THUMB });
  q = (await admin('GET', '/api/admin/state')).data.queue[0];
  await admin('POST', `/api/admin/submissions/${q.id}/reject`, { reason: 'weer nee' });
  s1 = (await p1('GET', '/api/state')).data;
  assert.equal(card(1).status, 'final_rejected');
  assert.equal((await p1('POST', `/api/cards/${c1}/photo`, { full: PHOTO, thumb: THUMB })).status, 400);

  // geen JPEG geweigerd
  const bad = await p1('POST', `/api/cards/${card(3).id}/photo`, { full: Buffer.from('<svg>').toString('base64'), thumb: THUMB });
  assert.equal(bad.status, 400);

  // einde: uploaden stopt
  await admin('POST', '/api/admin/game', { action: 'end' });
  assert.equal((await p1('POST', `/api/cards/${card(3).id}/photo`, { full: PHOTO, thumb: THUMB })).status, 400);
  assert.equal((await p1('POST', '/api/cards', { assignmentId: A[2] })).status, 400);

  // onthullen: feed + foto's van anderen zichtbaar
  await admin('POST', '/api/admin/game', { action: 'reveal' });
  const feed = await p2('GET', '/api/feed');
  assert.equal(feed.status, 200);
  assert.equal(feed.data.items.length, 2);
  assert.equal((await p2('GET', `/photos/${sub1b.id}/full`)).status, 200);

  // zip
  const zip = await admin('GET', '/api/admin/export.zip');
  assert.equal(zip.status, 200);
  const zipPath = path.join(DATA, 'out.zip');
  fs.writeFileSync(zipPath, zip.data);
  const list = execFileSync('unzip', ['-l', zipPath]).toString();
  assert.match(list, /ronde-1\/opdracht-1_de-kaasjes\.jpg/);
  assert.match(list, /ronde-1\/opdracht-1_team-zon\.jpg/);
  assert.match(list, /scores\.csv/);
  execFileSync('unzip', ['-tq', zipPath]);

  // tijdgestuurde ronde komt vanzelf vrij
  db().prepare('UPDATE rounds SET release_at = ? WHERE id = ?').run(Date.now() - 1000, r2);
  await admin('POST', '/api/admin/game', { action: 'reopen' });
  s1 = (await p1('GET', '/api/state')).data;
  assert.equal(s1.rounds[1].released, true);

  // wissen
  assert.equal((await admin('POST', '/api/admin/wipe', { confirm: 'nee' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/wipe', { confirm: 'WISSEN' })).status, 200);
  assert.equal((await p1('GET', '/api/state')).status, 401, 'spelers zijn weg');
  st = (await admin('GET', '/api/admin/state')).data;
  assert.equal(st.teams.length, 2);
  assert.equal(st.assignments.length, 6);
  assert.equal(fs.readdirSync(path.join(DATA, 'photos')).length, 0);
});
