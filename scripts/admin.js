'use strict';
// Beheerders beheren vanaf de commandline:
//   node scripts/admin.js add <naam> [wachtwoord]     (zonder wachtwoord wordt er een gemaakt)
//   node scripts/admin.js passwd <naam> [wachtwoord]
//   node scripts/admin.js remove <naam>
//   node scripts/admin.js master <naam>   (maakt deze beheerder master)
//   node scripts/admin.js list
const { db, hashPassword, generatePassword } = require('../lib/db');

const [cmd, name, pwArg] = process.argv.slice(2);
const genPw = generatePassword;

function done(msg) { console.log(msg); process.exit(0); }
function fail(msg) { console.error(msg); process.exit(1); }

if (cmd === 'list') {
  const rows = db.prepare('SELECT name, role FROM admins ORDER BY name').all();
  done(rows.length ? rows.map((r) => '- ' + r.name + (r.role === 'master' ? ' (master)' : '')).join('\n') : '(nog geen beheerders)');
} else if (cmd === 'add' || cmd === 'passwd') {
  if (!name) fail('Geef een naam op');
  const pw = pwArg || genPw();
  if (pw.length < 8) fail('Wachtwoord moet minstens 8 tekens zijn');
  const exists = db.prepare('SELECT id FROM admins WHERE name = ?').get(name);
  if (cmd === 'add') {
    if (exists) fail(`Beheerder ${name} bestaat al (gebruik passwd)`);
    const role = db.prepare("SELECT 1 FROM admins WHERE role = 'master'").get() ? 'admin' : 'master';
    db.prepare('INSERT INTO admins (name, pass_hash, created_at, role) VALUES (?, ?, ?, ?)').run(name, hashPassword(pw), Date.now(), role);
  } else {
    if (!exists) fail(`Beheerder ${name} bestaat niet`);
    db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(hashPassword(pw), exists.id);
    db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND ref_id = ?").run(exists.id);
  }
  done(`Beheerder: ${name}\nWachtwoord: ${pw}`);
} else if (cmd === 'remove') {
  const a = db.prepare('SELECT id, role FROM admins WHERE name = ?').get(name || '');
  if (!a) fail('Niet gevonden');
  if (a.role === 'master') fail('De master kan niet verwijderd worden (maak eerst iemand anders master)');
  db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND ref_id = ?").run(a.id);
  db.prepare('DELETE FROM admins WHERE id = ?').run(a.id);
  done(`Verwijderd: ${name}`);
} else if (cmd === 'master') {
  const a = db.prepare('SELECT id FROM admins WHERE name = ?').get(name || '');
  if (!a) fail('Niet gevonden');
  db.prepare("UPDATE admins SET role = 'admin' WHERE role = 'master'").run();
  db.prepare("UPDATE admins SET role = 'master' WHERE id = ?").run(a.id);
  done(`${name} is nu master`);
} else {
  fail('Gebruik: node scripts/admin.js add|passwd|remove|master|list <naam> [wachtwoord]');
}
