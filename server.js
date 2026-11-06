'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, tx, getSetting, setSetting, verifyPassword, hashPassword, generatePassword, newTeamCode, PHOTO_DIR } = require('./lib/db');
const { calcPoints } = require('./public/scoring');
const { stripJpegMetadata } = require('./lib/jpeg');
const { createZip } = require('./lib/zip');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 3;

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const now = () => Date.now();

// een beheerder die zelf meespeelt mag zijn eigen team niet beoordelen of punten geven
function guardOwnTeam(admin, teamId) {
  if (admin.team_id && admin.team_id === teamId) {
    throw new HttpError(403, 'Je speelt zelf in dit team. Laat een andere beheerder dit doen.');
  }
}
function requireMaster(admin) {
  if (admin.role !== 'master') throw new HttpError(403, 'Alleen de master-beheerder kan beheerders beheren');
}

function settings() {
  return {
    status: getSetting('status', 'setup'),          // setup | running | ended | revealed
    maxOpen: Number(getSetting('max_open', 3)),
    freeMinutes: Number(getSetting('free_minutes', 5)),
    endTime: Number(getSetting('end_time', 0)) || null,
  };
}
function effectiveStatus(t = now()) {
  const s = settings();
  if (s.status === 'running' && s.endTime && t >= s.endTime) return 'ended';
  return s.status;
}
const isReleased = (r, t = now()) => !!r.released_at || (!!r.release_at && t >= r.release_at);
const isRunningCard = (c) => c.status === 'open' || c.status === 'rejected';
function cardActiveMs(c, t = now()) {
  return c.used_ms + (isRunningCard(c) && c.resumed_at ? Math.max(0, t - c.resumed_at) : 0);
}
function int(v, def, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function str(v, max = 200) { return String(v ?? '').trim().slice(0, max); }
function slug(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
}

// ---------- live updates (SSE) ----------
const clients = new Set();
function broadcast() {
  for (const res of clients) {
    try { res.write('data: refresh\n\n'); } catch { /* verbinding weg */ }
  }
}
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch {} } }, 25000).unref();

// Rondes die op tijd vrijkomen en de eindtijd: stuur een refresh zodra het zover is.
let lastTickState = '';
setInterval(() => {
  const t = now();
  const released = db.prepare('SELECT * FROM rounds').all().filter((r) => isReleased(r, t)).map((r) => r.id).join(',');
  const state = effectiveStatus(t) + '|' + released;
  if (state !== lastTickState) { if (lastTickState) broadcast(); lastTickState = state; }
}, 5000).unref();

// ---------- sessies ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-visitor']; }
function setCookie(req, res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...prev, parts.join('; ')]);
}
function createSession(req, res, kind, refId) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions (token, kind, ref_id, created_at) VALUES (?, ?, ?, ?)').run(token, kind, refId, now());
  setCookie(req, res, kind === 'admin' ? 'fs_admin' : 'fs_player', token, SESSION_DAYS * 86400);
}
function loadSession(req, kind) {
  const token = parseCookies(req)[kind === 'admin' ? 'fs_admin' : 'fs_player'];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ? AND kind = ?').get(token, kind);
  if (!s || now() - s.created_at > SESSION_DAYS * 86400000) return null;
  if (kind === 'admin') return db.prepare('SELECT id, name, role, team_id FROM admins WHERE id = ?').get(s.ref_id) || null;
  return db.prepare(`SELECT p.id, p.name, p.team_id, t.name AS team_name
                     FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = ?`).get(s.ref_id) || null;
}

// eenvoudige rem op foute inlogpogingen
const failures = new Map();
function clientIp(req) { return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?'; }
function checkRate(req, key) {
  const k = key + ':' + clientIp(req);
  const f = failures.get(k);
  if (f && f.count >= 10 && now() - f.first < 10 * 60000) throw new HttpError(429, 'Te veel pogingen. Wacht een paar minuten.');
}
function noteFailure(req, key) {
  const k = key + ':' + clientIp(req);
  const f = failures.get(k);
  if (!f || now() - f.first > 10 * 60000) failures.set(k, { count: 1, first: now() });
  else f.count++;
}

// ---------- spellogica ----------
function categoriesMap() {
  const m = new Map();
  for (const c of db.prepare('SELECT * FROM categories').all()) m.set(c.id, { id: c.id, name: c.name, color: c.color });
  return m;
}

function recomputeFirstBonus(assignmentId) {
  db.prepare("DELETE FROM bonuses WHERE auto = 'first' AND assignment_id = ?").run(assignmentId);
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
  if (!a || a.first_bonus <= 0) return;
  const first = db.prepare(`SELECT s.id, c.team_id FROM submissions s JOIN cards c ON c.id = s.card_id
    WHERE c.assignment_id = ? AND s.status = 'approved' ORDER BY s.uploaded_at, s.id LIMIT 1`).get(assignmentId);
  if (first) {
    db.prepare(`INSERT INTO bonuses (team_id, assignment_id, points, description, auto, created_at)
      VALUES (?, ?, ?, ?, 'first', ?)`).run(first.team_id, assignmentId, a.first_bonus, `Eerste team: ${a.title}`, now());
  }
}

function scoreboard() {
  const teams = db.prepare('SELECT id, name FROM teams ORDER BY name').all();
  const photo = new Map(db.prepare(`SELECT c.team_id, SUM(s.points) AS p, COUNT(*) AS n FROM submissions s
    JOIN cards c ON c.id = s.card_id WHERE s.status = 'approved' GROUP BY c.team_id`).all().map((r) => [r.team_id, r]));
  const bonus = new Map(db.prepare('SELECT team_id, SUM(points) AS p FROM bonuses GROUP BY team_id').all().map((r) => [r.team_id, r.p]));
  const rows = teams.map((t) => {
    const pp = photo.get(t.id)?.p || 0;
    const bp = bonus.get(t.id) || 0;
    return { id: t.id, name: t.name, photoPoints: pp, bonusPoints: bp, total: pp + bp, done: photo.get(t.id)?.n || 0 };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const cats = db.prepare('SELECT * FROM categories ORDER BY name').all();
  const perCat = db.prepare(`SELECT c.team_id, a.category_id, SUM(s.points) AS p, COUNT(*) AS n FROM submissions s
    JOIN cards c ON c.id = s.card_id JOIN assignments a ON a.id = c.assignment_id
    WHERE s.status = 'approved' AND a.category_id IS NOT NULL GROUP BY c.team_id, a.category_id`).all();
  const categories = cats.map((cat) => {
    const list = teams.map((t) => {
      const r = perCat.find((x) => x.team_id === t.id && x.category_id === cat.id);
      return { teamId: t.id, name: t.name, points: r?.p || 0, done: r?.n || 0 };
    }).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    return { id: cat.id, name: cat.name, color: cat.color, teams: list };
  });

  const bonuses = db.prepare(`SELECT b.id, b.team_id AS teamId, b.points, b.description, b.created_at, t.name AS team FROM bonuses b
    JOIN teams t ON t.id = b.team_id ORDER BY b.created_at DESC LIMIT 15`).all();
  return { teams: rows, categories, bonuses };
}

function playerState(player) {
  const t = now();
  const s = settings();
  const status = effectiveStatus(t);
  const cats = categoriesMap();
  const memberRows = db.prepare('SELECT id, name FROM players WHERE team_id = ? ORDER BY name').all(player.team_id);
  const members = memberRows.map((r) => r.name);
  const memberName = new Map(memberRows.map((r) => [r.id, r.name]));
  const cards = new Map(db.prepare('SELECT * FROM cards WHERE team_id = ?').all(player.team_id).map((c) => [c.assignment_id, c]));
  const subs = db.prepare(`SELECT s.* FROM submissions s JOIN cards c ON c.id = s.card_id WHERE c.team_id = ?
    ORDER BY s.attempt`).all(player.team_id);
  const latest = new Map();
  for (const sub of subs) latest.set(sub.card_id, sub);
  const firstBonus = new Set(db.prepare("SELECT assignment_id FROM bonuses WHERE auto = 'first' AND team_id = ?")
    .all(player.team_id).map((r) => r.assignment_id));

  const rounds = [];
  if (status !== 'setup') {
    const allAssignments = db.prepare('SELECT * FROM assignments ORDER BY sort, id').all();
    for (const r of db.prepare('SELECT * FROM rounds ORDER BY sort, id').all()) {
      if (!isReleased(r, t)) { rounds.push({ id: r.id, name: r.name, released: false, releaseAt: r.release_at || null }); continue; }
      const items = allAssignments.filter((a) => a.round_id === r.id).map((a) => {
        const item = {
          id: a.id, category: a.category_id ? cats.get(a.category_id) || null : null,
          basePoints: a.base_points, decayPerMin: a.decay_per_min, floorPoints: a.floor_points, firstBonus: a.first_bonus,
        };
        const c = cards.get(a.id);
        if (c) {
          const sub = latest.get(c.id);
          item.title = a.title;
          item.text = a.text;
          item.card = {
            id: c.id, status: c.status, activeMs: cardActiveMs(c, t), running: isRunningCard(c),
            attempts: sub ? sub.attempt : 0,
            reason: sub && sub.status === 'rejected' ? sub.reason : null,
            points: sub && sub.status === 'approved' ? sub.points : null,
            firstBonus: firstBonus.has(a.id),
            photo: sub ? `/photos/${sub.id}/thumb` : null,
            openedBy: c.opened_by ? (c.opened_by === player.id ? 'jij' : memberName.get(c.opened_by) || null) : null,
            uploadedBy: sub && sub.uploaded_by ? (sub.uploaded_by === player.id ? 'jij' : memberName.get(sub.uploaded_by) || null) : null,
          };
        }
        return item;
      });
      rounds.push({ id: r.id, name: r.name, released: true, assignments: items });
    }
  }
  const all = [...cards.values()];
  return {
    serverNow: t,
    game: { status, maxOpen: s.maxOpen, freeMinutes: s.freeMinutes, endTime: s.endTime },
    me: { id: player.id, name: player.name },
    team: { id: player.team_id, name: player.team_name, members },
    openCount: all.filter((c) => c.status === 'open').length,
    retryOpen: all.some((c) => c.status === 'rejected'),
    rounds,
  };
}

function adminState(me) {
  const t = now();
  const s = settings();
  const cats = db.prepare('SELECT * FROM categories ORDER BY name').all();
  const rounds = db.prepare('SELECT * FROM rounds ORDER BY sort, id').all().map((r) => ({ ...r, released: isReleased(r, t) }));
  const assignments = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM cards c WHERE c.assignment_id = a.id) AS card_count
    FROM assignments a ORDER BY sort, id`).all();
  const teams = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM cards c WHERE c.team_id = t.id) AS card_count
    FROM teams t ORDER BY name`).all().map((tm) => ({
    ...tm,
    players: db.prepare('SELECT id, name FROM players WHERE team_id = ? ORDER BY name').all(tm.id),
    openCards: db.prepare("SELECT COUNT(*) AS n FROM cards WHERE team_id = ? AND status = 'open'").get(tm.id).n,
  }));
  const admins = Object.fromEntries(db.prepare('SELECT id, name FROM admins').all().map((a) => [a.id, a.name]));
  const subRow = `SELECT s.*, c.team_id, c.assignment_id, t.name AS team, a.title, a.text, a.base_points, a.decay_per_min,
      a.floor_points, a.category_id FROM submissions s JOIN cards c ON c.id = s.card_id JOIN teams t ON t.id = c.team_id
      JOIN assignments a ON a.id = c.assignment_id`;
  const queue = db.prepare(`${subRow} WHERE s.status = 'pending' ORDER BY s.uploaded_at`).all().map((q) => ({
    id: q.id, team: q.team, teamId: q.team_id, assignmentId: q.assignment_id, title: q.title, text: q.text,
    categoryId: q.category_id, attempt: q.attempt, uploadedAt: q.uploaded_at, effectiveMs: q.effective_ms,
    previewPoints: calcPoints(q.effective_ms, q, s.freeMinutes),
    lockedBy: q.locked_by && t - q.locked_at < 3 * 60000 ? admins[q.locked_by] || '?' : null,
    lockedById: q.locked_by && t - q.locked_at < 3 * 60000 ? q.locked_by : null,
    ownTeam: !!me.team_id && me.team_id === q.team_id,
  }));
  const reviewed = db.prepare(`${subRow} WHERE s.status != 'pending' ORDER BY s.reviewed_at DESC LIMIT 20`).all().map((q) => ({
    id: q.id, team: q.team, title: q.title, attempt: q.attempt, status: q.status, points: q.points, reason: q.reason,
    reviewedAt: q.reviewed_at, reviewedBy: admins[q.reviewed_by] || '?',
  }));
  const bonuses = db.prepare(`SELECT b.*, t.name AS team, a.title AS assignment FROM bonuses b JOIN teams t ON t.id = b.team_id
    LEFT JOIN assignments a ON a.id = b.assignment_id ORDER BY b.created_at DESC`).all()
    .map((b) => ({ ...b, admin: b.admin_id ? admins[b.admin_id] || '?' : null }));
  const adminList = db.prepare(`SELECT a.id, a.name, a.role, a.team_id, t.name AS team FROM admins a
    LEFT JOIN teams t ON t.id = a.team_id ORDER BY a.role = 'master' DESC, a.name`).all();
  return {
    serverNow: t,
    me: { id: me.id, name: me.name, role: me.role, teamId: me.team_id || null },
    admins: adminList,
    game: { ...s, effectiveStatus: effectiveStatus(t) },
    categories: cats, rounds, assignments, teams, queue, reviewed, bonuses,
    scoreboard: scoreboard(),
  };
}

function feedItems() {
  return db.prepare(`SELECT s.id, s.points, s.uploaded_at AS uploadedAt, t.name AS team, a.title, a.category_id AS categoryId,
      r.name AS round FROM submissions s JOIN cards c ON c.id = s.card_id JOIN teams t ON t.id = c.team_id
      JOIN assignments a ON a.id = c.assignment_id JOIN rounds r ON r.id = a.round_id
      WHERE s.status = 'approved' ORDER BY r.sort, r.id, a.sort, a.id, s.uploaded_at`).all();
}

function decodePhoto(b64, maxBytes) {
  if (typeof b64 !== 'string' || !b64) throw bad('Foto ontbreekt');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > maxBytes) throw bad('Foto is te groot');
  try { return stripJpegMetadata(buf); } catch { throw bad('Dit is geen geldige foto (JPEG)'); }
}

// ---------- routes ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}

// --- publiek / speler ---
route('GET', '/api/me', ({ player }) => ({ player }));

route('POST', '/api/join', ({ req, res, body }) => {
  checkRate(req, 'join');
  const code = str(body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = str(body.name, 30).replace(/\s+/g, ' ');
  if (!name) throw bad('Vul je naam in');
  const team = db.prepare('SELECT * FROM teams WHERE code = ?').get(code);
  if (!team) { noteFailure(req, 'join'); throw bad('Deze teamcode bestaat niet'); }
  let p = db.prepare('SELECT * FROM players WHERE team_id = ? AND name = ?').get(team.id, name);
  if (!p) {
    const id = db.prepare('INSERT INTO players (team_id, name, created_at) VALUES (?, ?, ?)').run(team.id, name, now()).lastInsertRowid;
    p = { id: Number(id) };
    broadcast();
  }
  createSession(req, res, 'player', p.id);
  return { ok: true };
});

route('POST', '/api/logout', ({ req, res }) => {
  const token = parseCookies(req).fs_player;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  setCookie(req, res, 'fs_player', '', 0);
  return { ok: true };
});

route('GET', '/api/state', ({ player }) => playerState(player), { player: true });

route('GET', '/api/scoreboard', () => scoreboard(), { anyone: true });

route('GET', '/api/feed', ({ admin }) => {
  if (!admin && effectiveStatus() !== 'revealed') throw new HttpError(403, 'De feed is nog niet onthuld');
  return { items: feedItems(), categories: db.prepare('SELECT * FROM categories').all() };
}, { anyone: true });

route('POST', '/api/cards', ({ player, body }) => {
  const assignmentId = int(body.assignmentId, 0);
  tx(() => {
    const t = now();
    if (effectiveStatus(t) !== 'running') throw bad('Het spel is niet bezig');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
    if (!a) throw bad('Onbekende opdracht');
    const r = db.prepare('SELECT * FROM rounds WHERE id = ?').get(a.round_id);
    if (!isReleased(r, t)) throw bad('Deze ronde is nog niet vrijgegeven');
    if (db.prepare('SELECT 1 FROM cards WHERE team_id = ? AND assignment_id = ?').get(player.team_id, a.id)) throw bad('Dit kaartje is al geopend');
    const teamCards = db.prepare('SELECT status FROM cards WHERE team_id = ?').all(player.team_id);
    if (teamCards.some((c) => c.status === 'rejected')) throw bad('Lever eerst je herkansing in voordat je een nieuw kaartje opent');
    const max = settings().maxOpen;
    if (teamCards.filter((c) => c.status === 'open').length >= max) throw bad(`Je hebt al ${max} open kaartjes. Sluit er eerst een.`);
    db.prepare(`INSERT INTO cards (team_id, assignment_id, status, opened_at, opened_by, used_ms, resumed_at)
      VALUES (?, ?, 'open', ?, ?, 0, ?)`).run(player.team_id, a.id, t, player.id, t);
  });
  broadcast();
  return { ok: true };
}, { player: true });

route('POST', '/api/cards/:id/close', ({ player, params }) => {
  tx(() => {
    const c = db.prepare('SELECT * FROM cards WHERE id = ? AND team_id = ?').get(int(params.id, 0), player.team_id);
    if (!c) throw new HttpError(404, 'Kaartje niet gevonden');
    if (!isRunningCard(c)) throw bad('Dit kaartje kan niet meer gesloten worden');
    db.prepare("UPDATE cards SET status = 'closed', closed_at = ?, used_ms = ?, resumed_at = NULL WHERE id = ?")
      .run(now(), cardActiveMs(c), c.id);
  });
  broadcast();
  return { ok: true };
}, { player: true });

route('POST', '/api/cards/:id/photo', ({ player, params, body }) => {
  const t = now();
  const c0 = db.prepare('SELECT * FROM cards WHERE id = ? AND team_id = ?').get(int(params.id, 0), player.team_id);
  if (!c0) throw new HttpError(404, 'Kaartje niet gevonden');
  if (effectiveStatus(t) !== 'running') throw bad('Het spel is afgelopen, uploaden kan niet meer');
  if (!isRunningCard(c0)) throw bad(c0.status === 'submitted' ? 'Deze foto is al ingestuurd' : 'Dit kaartje is niet meer open');
  const full = decodePhoto(body.full, 12 * 1024 * 1024);
  const thumb = decodePhoto(body.thumb, 2 * 1024 * 1024);
  const base = `${c0.id}-${crypto.randomBytes(6).toString('hex')}`;
  const fullName = `${base}.jpg`;
  const thumbName = `${base}-t.jpg`;
  fs.writeFileSync(path.join(PHOTO_DIR, fullName), full);
  fs.writeFileSync(path.join(PHOTO_DIR, thumbName), thumb);
  try {
    tx(() => {
      const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(c0.id);
      if (!isRunningCard(c)) throw bad('Deze foto is al ingestuurd');
      const attempt = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE card_id = ?').get(c.id).n + 1;
      if (attempt > 2) throw bad('Je hebt geen pogingen meer');
      const effective = cardActiveMs(c, t);
      db.prepare(`INSERT INTO submissions (card_id, attempt, file, thumb, uploaded_at, uploaded_by, effective_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(c.id, attempt, fullName, thumbName, t, player.id, effective);
      db.prepare("UPDATE cards SET status = 'submitted', used_ms = ?, resumed_at = NULL WHERE id = ?").run(effective, c.id);
    });
  } catch (e) {
    for (const f of [fullName, thumbName]) fs.rmSync(path.join(PHOTO_DIR, f), { force: true });
    throw e;
  }
  broadcast();
  return { ok: true };
}, { player: true, bodyLimit: 20 * 1024 * 1024 });

// foto's: eigen team altijd, beheerders altijd, anderen na onthulling (alleen goedgekeurd)
route('GET', '/photos/:id/:size', ({ req, res, params, player, admin }) => {
  const sub = db.prepare('SELECT s.*, c.team_id FROM submissions s JOIN cards c ON c.id = s.card_id WHERE s.id = ?').get(int(params.id, 0));
  if (!sub) throw new HttpError(404, 'Niet gevonden');
  const allowed = admin || (player && (player.team_id === sub.team_id ||
    (sub.status === 'approved' && effectiveStatus() === 'revealed')));
  if (!allowed) throw new HttpError(403, 'Geen toegang');
  const file = path.join(PHOTO_DIR, params.size === 'thumb' ? sub.thumb : sub.file);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Bestand niet gevonden');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  fs.createReadStream(file).pipe(res);
  return undefined;
}, { anyone: true, raw: true });

route('GET', '/api/events', ({ req, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
  return undefined;
}, { anyone: true, raw: true, needSession: true });

// --- beheer ---
route('POST', '/api/admin/login', ({ req, res, body }) => {
  checkRate(req, 'admin');
  const a = db.prepare('SELECT * FROM admins WHERE name = ?').get(str(body.name, 60));
  if (!a || !verifyPassword(String(body.password || ''), a.pass_hash)) { noteFailure(req, 'admin'); throw bad('Naam of wachtwoord klopt niet'); }
  createSession(req, res, 'admin', a.id);
  return { ok: true };
});
route('POST', '/api/admin/logout', ({ req, res }) => {
  const token = parseCookies(req).fs_admin;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  setCookie(req, res, 'fs_admin', '', 0);
  return { ok: true };
});
route('GET', '/api/admin/me', ({ admin }) => ({ admin: admin ? { id: admin.id, name: admin.name, role: admin.role } : null }));
route('GET', '/api/admin/state', ({ admin }) => adminState(admin), { admin: true });

route('POST', '/api/admin/settings', ({ body }) => {
  if (body.maxOpen !== undefined) setSetting('max_open', int(body.maxOpen, 3, 1, 50));
  if (body.freeMinutes !== undefined) setSetting('free_minutes', Math.max(0, Math.min(600, Number(body.freeMinutes) || 0)));
  if (body.endTime !== undefined) setSetting('end_time', body.endTime ? int(body.endTime, 0, 0) : '');
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/game', ({ body }) => {
  const action = body.action;
  const s = effectiveStatus();
  if (action === 'start') setSetting('status', 'running');
  else if (action === 'end') {
    setSetting('status', 'ended');
  } else if (action === 'reveal') setSetting('status', 'revealed');
  else if (action === 'reopen') {
    // terug naar 'bezig'; een verlopen eindtijd wordt gewist
    const e = settings().endTime;
    if (e && e <= now()) setSetting('end_time', '');
    setSetting('status', 'running');
  } else if (action === 'setup') {
    if (s !== 'setup' && db.prepare('SELECT COUNT(*) AS n FROM cards').get().n > 0) throw bad('Er zijn al kaartjes geopend. Gebruik Alles wissen.');
    setSetting('status', 'setup');
  } else throw bad('Onbekende actie');
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/categories', ({ body }) => {
  const name = str(body.name, 40);
  const color = /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#7c6cf0';
  if (!name) throw bad('Naam ontbreekt');
  if (body.id) db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(name, color, int(body.id, 0));
  else db.prepare('INSERT INTO categories (name, color) VALUES (?, ?)').run(name, color);
  broadcast();
  return { ok: true };
}, { admin: true });
route('DELETE', '/api/admin/categories/:id', ({ params }) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(int(params.id, 0));
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/rounds', ({ body }) => {
  const name = str(body.name, 60);
  if (!name) throw bad('Naam ontbreekt');
  const releaseAt = body.releaseAt ? int(body.releaseAt, 0, 0) : null;
  if (body.id) db.prepare('UPDATE rounds SET name = ?, sort = ?, release_at = ? WHERE id = ?').run(name, int(body.sort, 0), releaseAt, int(body.id, 0));
  else {
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM rounds').get().s;
    db.prepare('INSERT INTO rounds (name, sort, release_at) VALUES (?, ?, ?)').run(name, sort, releaseAt);
  }
  broadcast();
  return { ok: true };
}, { admin: true });
route('POST', '/api/admin/rounds/:id/release', ({ params, body }) => {
  db.prepare('UPDATE rounds SET released_at = ? WHERE id = ?').run(body.undo ? null : now(), int(params.id, 0));
  broadcast();
  return { ok: true };
}, { admin: true });
route('DELETE', '/api/admin/rounds/:id', ({ params }) => {
  const id = int(params.id, 0);
  const n = db.prepare('SELECT COUNT(*) AS n FROM cards c JOIN assignments a ON a.id = c.assignment_id WHERE a.round_id = ?').get(id).n;
  if (n > 0) throw bad('Deze ronde heeft al geopende kaartjes en kan niet weg');
  db.prepare('DELETE FROM rounds WHERE id = ?').run(id);
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/assignments', ({ body }) => {
  const title = str(body.title, 80);
  if (!title) throw bad('Titel ontbreekt');
  const roundId = int(body.roundId, 0);
  if (!db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(roundId)) throw bad('Kies een ronde');
  const catId = body.categoryId ? int(body.categoryId, 0) : null;
  const v = [roundId, catId, title, str(body.text, 2000), int(body.basePoints, 100, 0, 100000),
    Math.max(0, Math.min(10000, Number(body.decayPerMin) || 0)), int(body.floorPoints, 30, 0, 100000),
    int(body.firstBonus, 0, 0, 100000), int(body.sort, 0)];
  let id;
  tx(() => {
    if (body.id) {
      id = int(body.id, 0);
      db.prepare(`UPDATE assignments SET round_id = ?, category_id = ?, title = ?, text = ?, base_points = ?, decay_per_min = ?,
        floor_points = ?, first_bonus = ?, sort = ? WHERE id = ?`).run(...v, id);
      recomputeFirstBonus(id);
    } else {
      if (!body.sort) v[8] = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM assignments').get().s;
      id = Number(db.prepare(`INSERT INTO assignments (round_id, category_id, title, text, base_points, decay_per_min, floor_points,
        first_bonus, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...v).lastInsertRowid);
    }
  });
  broadcast();
  return { ok: true, id };
}, { admin: true });
route('DELETE', '/api/admin/assignments/:id', ({ params }) => {
  const id = int(params.id, 0);
  if (db.prepare('SELECT COUNT(*) AS n FROM cards WHERE assignment_id = ?').get(id).n > 0) throw bad('Deze opdracht is al door een team geopend en kan niet weg');
  db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/teams', ({ body }) => {
  const name = str(body.name, 40);
  if (!name) throw bad('Naam ontbreekt');
  if (body.id) db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, int(body.id, 0));
  else db.prepare('INSERT INTO teams (name, code) VALUES (?, ?)').run(name, newTeamCode());
  broadcast();
  return { ok: true };
}, { admin: true });
route('POST', '/api/admin/teams/:id/newcode', ({ params }) => {
  const id = int(params.id, 0);
  db.prepare('UPDATE teams SET code = ? WHERE id = ?').run(newTeamCode(), id);
  return { ok: true };
}, { admin: true });
route('DELETE', '/api/admin/teams/:id', ({ params }) => {
  const id = int(params.id, 0);
  if (db.prepare('SELECT COUNT(*) AS n FROM cards WHERE team_id = ?').get(id).n > 0) throw bad('Dit team heeft al kaartjes geopend en kan niet weg');
  db.prepare("DELETE FROM sessions WHERE kind = 'player' AND ref_id IN (SELECT id FROM players WHERE team_id = ?)").run(id);
  db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  broadcast();
  return { ok: true };
}, { admin: true });
route('DELETE', '/api/admin/players/:id', ({ params }) => {
  const id = int(params.id, 0);
  db.prepare("DELETE FROM sessions WHERE kind = 'player' AND ref_id = ?").run(id);
  db.prepare('UPDATE cards SET opened_by = NULL WHERE opened_by = ?').run(id);
  db.prepare('DELETE FROM players WHERE id = ?').run(id);
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/submissions/:id/claim', ({ admin, params }) => {
  db.prepare("UPDATE submissions SET locked_by = ?, locked_at = ? WHERE id = ? AND status = 'pending'").run(admin.id, now(), int(params.id, 0));
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/submissions/:id/approve', ({ admin, params, body }) => {
  tx(() => {
    const t = now();
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(int(params.id, 0));
    if (!sub || sub.status !== 'pending') throw bad('Deze foto is al beoordeeld');
    const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(sub.card_id);
    guardOwnTeam(admin, c.team_id);
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(c.assignment_id);
    const points = calcPoints(sub.effective_ms, a, settings().freeMinutes);
    db.prepare("UPDATE submissions SET status = 'approved', points = ?, reviewed_by = ?, reviewed_at = ?, reason = NULL WHERE id = ?")
      .run(points, admin.id, t, sub.id);
    db.prepare("UPDATE cards SET status = 'approved' WHERE id = ?").run(c.id);
    const bonus = int(body.bonusPoints, 0);
    if (bonus) {
      db.prepare(`INSERT INTO bonuses (team_id, assignment_id, points, description, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(c.team_id, a.id, bonus, str(body.bonusText, 120) || (bonus > 0 ? `Bonus: ${a.title}` : `Strafpunten: ${a.title}`), admin.id, t);
    }
    recomputeFirstBonus(a.id);
  });
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/submissions/:id/reject', ({ admin, params, body }) => {
  const reason = str(body.reason, 300);
  if (!reason) throw bad('Geef een reden op');
  tx(() => {
    const t = now();
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(int(params.id, 0));
    if (!sub || sub.status !== 'pending') throw bad('Deze foto is al beoordeeld');
    guardOwnTeam(admin, db.prepare('SELECT team_id FROM cards WHERE id = ?').get(sub.card_id).team_id);
    db.prepare("UPDATE submissions SET status = 'rejected', reason = ?, points = NULL, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .run(reason, admin.id, t, sub.id);
    if (sub.attempt === 1) db.prepare("UPDATE cards SET status = 'rejected', resumed_at = ? WHERE id = ?").run(t, sub.card_id);
    else db.prepare("UPDATE cards SET status = 'final_rejected' WHERE id = ?").run(sub.card_id);
  });
  broadcast();
  return { ok: true };
}, { admin: true });

// beoordeling terugdraaien (vergissing)
route('POST', '/api/admin/submissions/:id/reset', ({ admin, params }) => {
  tx(() => {
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(int(params.id, 0));
    if (!sub || sub.status === 'pending') throw bad('Niets om terug te draaien');
    const later = db.prepare('SELECT 1 FROM submissions WHERE card_id = ? AND attempt > ?').get(sub.card_id, sub.attempt);
    if (later) throw bad('Het team heeft al een nieuwe foto ingestuurd; dit kan niet meer terug');
    const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(sub.card_id);
    guardOwnTeam(admin, c.team_id);
    db.prepare(`UPDATE submissions SET status = 'pending', points = NULL, reason = NULL, reviewed_by = NULL, reviewed_at = NULL,
      locked_by = NULL, locked_at = NULL WHERE id = ?`).run(sub.id);
    db.prepare("UPDATE cards SET status = 'submitted', resumed_at = NULL, used_ms = ? WHERE id = ?").run(sub.effective_ms, c.id);
    recomputeFirstBonus(c.assignment_id);
  });
  broadcast();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/bonuses', ({ admin, body }) => {
  const teamId = int(body.teamId, 0);
  if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw bad('Kies een team');
  guardOwnTeam(admin, teamId);
  const points = int(body.points, 0, -100000, 100000);
  if (!points) throw bad('Vul punten in (negatief voor strafpunten)');
  const description = str(body.description, 120);
  if (!description) throw bad('Geef een omschrijving');
  const aid = body.assignmentId ? int(body.assignmentId, 0) : null;
  db.prepare('INSERT INTO bonuses (team_id, assignment_id, points, description, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(teamId, aid, points, description, admin.id, now());
  broadcast();
  return { ok: true };
}, { admin: true });
route('DELETE', '/api/admin/bonuses/:id', ({ admin, params }) => {
  const b = db.prepare('SELECT team_id FROM bonuses WHERE id = ?').get(int(params.id, 0));
  if (b) guardOwnTeam(admin, b.team_id);
  db.prepare("DELETE FROM bonuses WHERE id = ? AND auto IS NULL").run(int(params.id, 0));
  broadcast();
  return { ok: true };
}, { admin: true });

// --- beheerders beheren (alleen master) ---
route('POST', '/api/admin/admins', ({ admin, body }) => {
  requireMaster(admin);
  const name = str(body.name, 60);
  if (!name) throw bad('Vul een naam in');
  if (db.prepare('SELECT 1 FROM admins WHERE name = ?').get(name)) throw bad('Er is al een beheerder met deze naam');
  const teamId = body.teamId ? int(body.teamId, 0) : null;
  const pw = generatePassword();
  db.prepare("INSERT INTO admins (name, pass_hash, created_at, role, team_id) VALUES (?, ?, ?, 'admin', ?)").run(name, hashPassword(pw), now(), teamId);
  return { ok: true, name, password: pw };
}, { admin: true });
route('POST', '/api/admin/admins/:id', ({ admin, params, body }) => {
  requireMaster(admin);
  const id = int(params.id, 0);
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'Beheerder niet gevonden');
  const teamId = body.teamId ? int(body.teamId, 0) : null;
  if (teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw bad('Onbekend team');
  db.prepare('UPDATE admins SET team_id = ? WHERE id = ?').run(teamId, id);
  return { ok: true };
}, { admin: true });
route('POST', '/api/admin/admins/:id/reset', ({ admin, params }) => {
  requireMaster(admin);
  const id = int(params.id, 0);
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'Beheerder niet gevonden');
  if (target.role === 'master') throw bad('Je eigen wachtwoord wijzig je via de server');
  const pw = generatePassword();
  db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(hashPassword(pw), id);
  db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND ref_id = ?").run(id);
  return { ok: true, name: target.name, password: pw };
}, { admin: true });
route('DELETE', '/api/admin/admins/:id', ({ admin, params }) => {
  requireMaster(admin);
  const id = int(params.id, 0);
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'Beheerder niet gevonden');
  if (target.role === 'master') throw bad('De master-beheerder kan niet verwijderd worden');
  db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND ref_id = ?").run(id);
  db.prepare('UPDATE submissions SET locked_by = NULL WHERE locked_by = ?').run(id);
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  return { ok: true };
}, { admin: true });

route('GET', '/api/admin/export.zip', ({ res }) => {
  const rows = db.prepare(`SELECT s.file, s.points, r.sort AS rsort, r.name AS round, a.sort AS asort, a.title, t.name AS team
    FROM submissions s JOIN cards c ON c.id = s.card_id JOIN teams t ON t.id = c.team_id JOIN assignments a ON a.id = c.assignment_id
    JOIN rounds r ON r.id = a.round_id WHERE s.status = 'approved' ORDER BY r.sort, a.sort, t.name`).all();
  const files = [];
  const used = new Set();
  for (const r of rows) {
    const p = path.join(PHOTO_DIR, r.file);
    if (!fs.existsSync(p)) continue;
    let name = `${slug(r.round)}/${slug(r.title)}_${slug(r.team)}.jpg`;
    let n = 2;
    while (used.has(name)) name = `${slug(r.round)}/${slug(r.title)}_${slug(r.team)}-${n++}.jpg`;
    used.add(name);
    files.push({ name, data: fs.readFileSync(p) });
  }
  const sb = scoreboard();
  const csvLines = ['positie;team;fotopunten;bonus;totaal;goedgekeurd'];
  sb.teams.forEach((t, i) => csvLines.push([i + 1, `"${t.name.replace(/"/g, '""')}"`, t.photoPoints, t.bonusPoints, t.total, t.done].join(';')));
  for (const cat of sb.categories) {
    csvLines.push('', `categorie: "${cat.name.replace(/"/g, '""')}";team;punten;foto's`);
    cat.teams.forEach((t, i) => csvLines.push([i + 1, `"${t.name.replace(/"/g, '""')}"`, t.points, t.done].join(';')));
  }
  files.push({ name: 'scores.csv', data: Buffer.from('﻿' + csvLines.join('\r\n'), 'utf8') });
  const zip = createZip(files);
  const date = new Date().toISOString().slice(0, 10);
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length,
    'Content-Disposition': `attachment; filename="fotospel-${date}.zip"` });
  res.end(zip);
  return undefined;
}, { admin: true, raw: true });

route('POST', '/api/admin/wipe', ({ body }) => {
  if (body.confirm !== 'WISSEN') throw bad('Typ WISSEN om te bevestigen');
  tx(() => {
    db.exec("DELETE FROM bonuses; DELETE FROM submissions; DELETE FROM cards; DELETE FROM sessions WHERE kind = 'player'; DELETE FROM players;");
    db.exec('UPDATE rounds SET released_at = NULL');
    if (body.teams) db.exec('DELETE FROM teams');
    if (body.assignments) db.exec('DELETE FROM assignments; DELETE FROM rounds; DELETE FROM categories;');
    setSetting('status', 'setup');
    setSetting('end_time', '');
  });
  for (const f of fs.readdirSync(PHOTO_DIR)) fs.rmSync(path.join(PHOTO_DIR, f), { force: true });
  broadcast();
  return { ok: true };
}, { admin: true });

// ---------- statische bestanden ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
// Versie per opstart: in HTML krijgen scripts en stylesheets ?v=<versie>, zodat telefoons
// en Cloudflare na een update nooit een oud bestand gebruiken.
const BUILD = Date.now().toString(36);
function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' ) rel = '/index.html';
  if (rel === '/beheer' || rel === '/beheer/') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  if (ext === '.html') {
    const html = fs.readFileSync(file, 'utf8').replace(/(src|href)="(\/[\w.-]+\.(?:js|css))"/g, `$1="$2?v=${BUILD}"`);
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
    res.end(html);
    return true;
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) {
      if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
      throw new HttpError(404, 'Niet gevonden');
    }
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const player = loadSession(req, 'player');
    const admin = loadSession(req, 'admin');
    if (r.opts.player && !player) throw new HttpError(401, 'Log opnieuw in');
    if ((r.opts.admin || pathname.startsWith('/api/admin/')) && !admin &&
        !['/api/admin/login', '/api/admin/logout', '/api/admin/me'].includes(pathname)) throw new HttpError(401, 'Log in als beheerder');
    if (r.opts.needSession && !player && !admin) throw new HttpError(401, 'Log in');
    let body = {};
    if (req.method === 'POST' || req.method === 'DELETE') {
      const raw = await readBody(req, r.opts.bodyLimit || 1024 * 1024);
      if (raw.length) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw bad('Verkeerd formaat');
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw bad('Ongeldige JSON'); }
      }
    }
    const out = await r.handler({ req, res, params, body, player, admin, query: url.searchParams });
    if (!r.opts.raw && !res.headersSent) sendJson(res, 200, out ?? { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, pathname, e);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Er ging iets mis op de server' : e.message });
    else res.end();
  }
});

// sessies van langer dan 3 dagen opruimen
setInterval(() => db.prepare('DELETE FROM sessions WHERE created_at < ?').run(now() - SESSION_DAYS * 86400000), 3600000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Fotospel draait op poort ${PORT}`));
}
module.exports = { server };
