'use strict';
// Beheerders: master-rol, toevoegen/resetten/verwijderen, meespelende beheerder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fotospel-adm-'));
const PORT = 5000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const PHOTO = fs.readFileSync(path.join(__dirname, 'photo-exif.jpg')).toString('base64');
const THUMB = fs.readFileSync(path.join(__dirname, 'thumb.jpg')).toString('base64');
const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT) };
let srv;

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie();
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test.before(async () => {
  // oude database zonder rol-kolommen nabootsen (zoals op de server)
  const old = new DatabaseSync(path.join(DATA, 'fotospel.db'));
  old.exec('CREATE TABLE admins (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL)');
  old.close();
  execFileSync('node', ['--no-warnings', 'scripts/admin.js', 'add', 'Michiel', 'geheimwachtwoord'], { cwd: ROOT, env });
  srv = spawn('node', ['--no-warnings', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.once('data', r));
});
test.after(() => { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('master en beheerders', async () => {
  const m = client(), sanne = client(), p1 = client(), p2 = client();
  await m('POST', '/api/admin/login', { name: 'Michiel', password: 'geheimwachtwoord' });
  let st = (await m('GET', '/api/admin/state')).data;
  assert.equal(st.me.role, 'master', 'eerste beheerder is master');
  assert.equal(execFileSync('node', ['--no-warnings', 'scripts/admin.js', 'list'], { cwd: ROOT, env }).toString().trim(), '- Michiel (master)');

  await m('POST', '/api/admin/teams', { name: 'Kaas' });
  await m('POST', '/api/admin/teams', { name: 'Zon' });
  await m('POST', '/api/admin/rounds', { name: 'R1' });
  st = (await m('GET', '/api/admin/state')).data;
  const kaas = st.teams.find((t) => t.name === 'Kaas'), zon = st.teams.find((t) => t.name === 'Zon');
  await m('POST', '/api/admin/assignments', { roundId: st.rounds[0].id, title: 'A', basePoints: 100, decayPerMin: 2, floorPoints: 30, firstBonus: 0 });

  // beheerder toevoegen die in Kaas speelt
  const add = await m('POST', '/api/admin/admins', { name: 'Sanne', teamId: kaas.id });
  assert.equal(add.status, 200);
  assert.ok(add.data.password.length >= 10);
  assert.equal((await m('POST', '/api/admin/admins', { name: 'sanne' })).status, 400, 'dubbele naam');
  assert.equal((await sanne('POST', '/api/admin/login', { name: 'Sanne', password: add.data.password })).status, 200);
  const sst = (await sanne('GET', '/api/admin/state')).data;
  assert.equal(sst.me.role, 'admin');
  assert.equal(sst.me.teamId, kaas.id);

  // gewone beheerder mag geen beheerders beheren
  assert.equal((await sanne('POST', '/api/admin/admins', { name: 'X' })).status, 403);
  const master = st.admins.find((a) => a.role === 'master');
  assert.equal((await sanne('DELETE', `/api/admin/admins/${master.id}`)).status, 403);
  assert.equal((await m('DELETE', `/api/admin/admins/${master.id}`)).status, 400, 'master niet verwijderbaar');

  // beide teams sturen een foto in
  await m('POST', '/api/admin/game', { action: 'start' });
  await m('POST', `/api/admin/rounds/${st.rounds[0].id}/release`, {});
  const aid = (await m('GET', '/api/admin/state')).data.assignments[0].id;
  for (const [p, team] of [[p1, kaas], [p2, zon]]) {
    await p('POST', '/api/join', { code: team.code, name: 'speler' });
    await p('POST', '/api/cards', { assignmentId: aid });
    const s = (await p('GET', '/api/state')).data;
    assert.equal((await p('POST', `/api/cards/${s.rounds[0].assignments[0].card.id}/photo`, { full: PHOTO, thumb: THUMB })).status, 200);
  }
  const q = (await sanne('GET', '/api/admin/state')).data.queue;
  const own = q.find((x) => x.teamId === kaas.id), other = q.find((x) => x.teamId === zon.id);
  assert.equal(own.ownTeam, true);
  assert.equal(other.ownTeam, false);
  assert.equal((await sanne('POST', `/api/admin/submissions/${own.id}/approve`, {})).status, 403, 'eigen team niet goedkeuren');
  assert.equal((await sanne('POST', `/api/admin/submissions/${own.id}/reject`, { reason: 'x' })).status, 403, 'eigen team niet afkeuren');
  assert.equal((await sanne('POST', '/api/admin/bonuses', { teamId: kaas.id, points: 50, description: 'x' })).status, 403, 'geen bonus eigen team');
  assert.equal((await sanne('POST', `/api/admin/submissions/${other.id}/approve`, {})).status, 200, 'ander team wel');
  assert.equal((await sanne('POST', '/api/admin/bonuses', { teamId: zon.id, points: -5, description: 'straf' })).status, 200);
  assert.equal((await m('POST', `/api/admin/submissions/${own.id}/approve`, {})).status, 200, 'master speelt niet mee en mag wel');
  assert.equal((await sanne('POST', `/api/admin/submissions/${own.id}/reset`, {})).status, 403, 'eigen team niet terugdraaien');

  // teamkoppeling wijzigen, wachtwoord resetten, verwijderen
  const sid = st.admins.length ? (await m('GET', '/api/admin/state')).data.admins.find((a) => a.name === 'Sanne').id : 0;
  assert.equal((await m('POST', `/api/admin/admins/${sid}`, { teamId: null })).status, 200);
  assert.equal((await sanne('POST', `/api/admin/submissions/${own.id}/reset`, {})).status, 200, 'na loskoppelen wel');
  const reset = await m('POST', `/api/admin/admins/${sid}/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal((await sanne('GET', '/api/admin/state')).status, 401, 'uitgelogd na reset');
  assert.equal((await sanne('POST', '/api/admin/login', { name: 'Sanne', password: reset.data.password })).status, 200);
  assert.equal((await m('DELETE', `/api/admin/admins/${sid}`)).status, 200);
  assert.equal((await sanne('GET', '/api/admin/state')).status, 401, 'weg na verwijderen');
  assert.equal((await m('GET', '/api/admin/state')).data.admins.length, 1);
});

test('foto-adres verandert als een nummer na wissen opnieuw gebruikt wordt', async () => {
  const m = client(), p = client();
  await m('POST', '/api/admin/login', { name: 'Michiel', password: 'geheimwachtwoord' });
  const urls = [];
  for (let round = 0; round < 2; round++) {
    await m('POST', '/api/admin/wipe', { confirm: 'WISSEN' });
    await m('POST', '/api/admin/game', { action: 'start' });
    const st = (await m('GET', '/api/admin/state')).data;
    await m('POST', `/api/admin/rounds/${st.rounds[0].id}/release`, {});
    await p('POST', '/api/join', { code: st.teams[0].code, name: 'x' + round });
    await p('POST', '/api/cards', { assignmentId: st.assignments[0].id });
    const s = (await p('GET', '/api/state')).data;
    await p('POST', `/api/cards/${s.rounds[0].assignments[0].card.id}/photo`, { full: PHOTO, thumb: THUMB });
    const q = (await m('GET', '/api/admin/state')).data.queue[0];
    const s2 = (await p('GET', '/api/state')).data;
    urls.push({ id: q.id, v: q.v, player: s2.rounds[0].assignments[0].card.photo });
  }
  assert.equal(urls[0].id, urls[1].id, 'nummer wordt hergebruikt');
  assert.notEqual(urls[0].v, urls[1].v, 'maar de versie verschilt');
  assert.notEqual(urls[0].player, urls[1].player);
  assert.equal((await p('GET', urls[1].player.replace('/thumb', '/full'))).status, 200);
});
