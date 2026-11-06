'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'fotospel.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#7c6cf0');
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  release_at INTEGER, released_at INTEGER);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  base_points INTEGER NOT NULL DEFAULT 100, decay_per_min REAL NOT NULL DEFAULT 2,
  floor_points INTEGER NOT NULL DEFAULT 30, first_bonus INTEGER NOT NULL DEFAULT 25,
  sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, created_at INTEGER NOT NULL, UNIQUE(team_id, name));
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  status TEXT NOT NULL,            -- open | submitted | approved | rejected | final_rejected | closed
  opened_at INTEGER NOT NULL, opened_by INTEGER,
  used_ms INTEGER NOT NULL DEFAULT 0, resumed_at INTEGER, closed_at INTEGER,
  UNIQUE(team_id, assignment_id));
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY, card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL, file TEXT NOT NULL, thumb TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL, uploaded_by INTEGER, effective_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  reviewed_by INTEGER, reviewed_at INTEGER, reason TEXT, points INTEGER,
  locked_by INTEGER, locked_at INTEGER);
CREATE TABLE IF NOT EXISTS bonuses (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
  points INTEGER NOT NULL, description TEXT NOT NULL, auto TEXT, admin_id INTEGER,
  created_at INTEGER NOT NULL);
`);

// migratie: rollen en teamkoppeling voor beheerders
{
  const cols = db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name);
  if (!cols.includes('role')) db.exec("ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  if (!cols.includes('team_id')) db.exec('ALTER TABLE admins ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL');
  const hasMaster = db.prepare("SELECT 1 FROM admins WHERE role = 'master'").get();
  if (!hasMaster) db.exec("UPDATE admins SET role = 'master' WHERE id = (SELECT id FROM admins ORDER BY created_at, id LIMIT 1)");
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newTeamCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM teams WHERE code = ?').get(code)) return code;
  }
}

function generatePassword() { return crypto.randomBytes(9).toString('base64url'); }

module.exports = { db, tx, generatePassword, getSetting, setSetting, hashPassword, verifyPassword, newTeamCode, DATA_DIR, PHOTO_DIR };
