'use strict';
// Maakt schermafbeeldingen op telefoonformaat met headless Chrome (via DevTools-protocol).
// Gebruik: node test/visual.js <uitvoermap>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fotospel-vis-'));
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

function client() {
  let cookie = '';
  const f = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie();
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return res.headers.get('content-type')?.includes('json') ? res.json() : null;
  };
  f.cookie = () => cookie;
  return f;
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

(async () => {
  const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT) };
  execFileSync('node', ['--no-warnings', 'scripts/admin.js', 'add', 'Michiel', 'geheimwachtwoord'], { cwd: ROOT, env });
  const srv = spawn('node', ['--no-warnings', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.once('data', r));

  // gegevens klaarzetten
  const admin = client(), p1 = client(), p2 = client();
  await admin('POST', '/api/admin/login', { name: 'Michiel', password: 'geheimwachtwoord' });
  await admin('POST', '/api/admin/categories', { name: 'Creatief', color: '#7c6cf0' });
  await admin('POST', '/api/admin/categories', { name: 'Groepsfoto', color: '#1f9d8b' });
  await admin('POST', '/api/admin/categories', { name: 'Durf', color: '#e8553a' });
  await admin('POST', '/api/admin/rounds', { name: 'Ronde 1 · Opwarmen' });
  await admin('POST', '/api/admin/rounds', { name: 'Ronde 2 · Op pad', releaseAt: Date.now() + 2 * 3600000 });
  let st = await admin('GET', '/api/admin/state');
  const [c1, c2, c3] = st.categories.map((c) => c.id).sort((a, b) => a - b);
  const r1 = st.rounds[0].id, r2 = st.rounds[1].id;
  const tasks = [
    ['Menselijke piramide', 'Maak een piramide met minstens drie mensen, buiten.', c2, 100],
    ['Vreemde hoed', 'Draag samen met een onbekende een zelfgemaakte hoed.', c3, 150],
    ['Spiegelbeeld', 'Fotografeer je team in een spiegeling, niet in een spiegel.', c1, 80],
    ['Standbeeld', 'Doe exact de houding van een standbeeld na.', c1, 100],
    ['Hoogste punt', 'Het hele team op het hoogste punt dat je kunt bereiken.', c2, 120],
  ];
  for (const [title, text, cat, pts] of tasks) await admin('POST', '/api/admin/assignments', { roundId: r1, categoryId: cat, title, text, basePoints: pts, decayPerMin: 2, floorPoints: 30, firstBonus: 25 });
  await admin('POST', '/api/admin/assignments', { roundId: r2, categoryId: c3, title: 'Later', text: 'x', basePoints: 100, decayPerMin: 2, floorPoints: 30, firstBonus: 25 });
  for (const n of ['De Kaasjes', 'Team Zon', 'Fotofanaten']) await admin('POST', '/api/admin/teams', { name: n });
  st = await admin('GET', '/api/admin/state');
  const team = (n) => st.teams.find((t) => t.name === n);
  await p1('POST', '/api/join', { code: team('De Kaasjes').code, name: 'Anna' });
  await client()('POST', '/api/join', { code: team('De Kaasjes').code, name: 'Bram' });
  await p2('POST', '/api/join', { code: team('Team Zon').code, name: 'Cas' });
  await admin('POST', '/api/admin/game', { action: 'start' });
  await admin('POST', `/api/admin/rounds/${r1}/release`, {});
  const A = st.assignments.map((a) => a.id);
  // team zon: één goedgekeurd
  const PHOTO = fs.readFileSync(path.join(__dirname, 'photo-exif.jpg')).toString('base64');
  const THUMB = fs.readFileSync(path.join(__dirname, 'thumb.jpg')).toString('base64');
  await p2('POST', '/api/cards', { assignmentId: A[0] });
  let s2 = await p2('GET', '/api/state');
  await p2('POST', `/api/cards/${s2.rounds[0].assignments[0].card.id}/photo`, { full: PHOTO, thumb: THUMB });
  st = await admin('GET', '/api/admin/state');
  await admin('POST', `/api/admin/submissions/${st.queue[0].id}/approve`, {});
  // kaasjes: één open (8 min geleden), één ingestuurd
  await p1('POST', '/api/cards', { assignmentId: A[1] });
  await p1('POST', '/api/cards', { assignmentId: A[2] });
  let s1 = await p1('GET', '/api/state');
  await p1('POST', `/api/cards/${s1.rounds[0].assignments[2].card.id}/photo`, { full: PHOTO, thumb: THUMB });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA, 'fotospel.db'));
  db.prepare('UPDATE cards SET opened_at = ?, resumed_at = ? WHERE id = ?').run(Date.now() - 8 * 60000, Date.now() - 8 * 60000, s1.rounds[0].assignments[1].card.id);

  // browser
  const port = 9300 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'));
  const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
  const page = targets.find((t) => t.type === 'page');
  const send = await cdp(page.webSocketDebuggerUrl);
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const errors = [];
  const shot = async (name, full = false) => {
    await sleep(700);
    const opts = { format: 'png' };
    if (full) {
      const m = await send('Page.getLayoutMetrics');
      opts.clip = { x: 0, y: 0, width: 390, height: Math.min(2400, Math.ceil(m.cssContentSize.height)), scale: 1 };
      opts.captureBeyondViewport = true;
    }
    const r = await send('Page.captureScreenshot', opts);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const go = async (url) => { await send('Page.navigate', { url: BASE + url }); await sleep(1200); };
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  const click = (sel) => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing'; e.click(); return 'ok'; })()`);

  await send('Network.clearBrowserCookies');
  await go('/beheer');
  await evalJs(`document.querySelector('[name=name]').value='Michiel'; document.querySelector('[name=password]').value='geheimwachtwoord'; document.querySelector('#login button').click(); 'ok'`);
  await sleep(1500);
  // tik op de foto (claim) en open afkeuren, typ een reden
  await evalJs(`(() => { const it = document.querySelector('.q-item'); it.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); document.querySelector('[data-reject-toggle]').click();
    const ta = document.querySelector('[data-reject-box] textarea'); ta.value = 'Half getypte reden'; ta.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()`);
  await sleep(1500); // claim -> verversing
  // nog een live verversing: ander team stuurt foto in
  const zon = client();
  await zon('POST', '/api/join', { code: team('Fotofanaten').code, name: 'Eva' });
  await zon('POST', '/api/cards', { assignmentId: A[3] });
  const sz = await zon('GET', '/api/state');
  await zon('POST', `/api/cards/${sz.rounds[0].assignments[3].card.id}/photo`, { full: PHOTO, thumb: THUMB });
  await sleep(2000);
  console.log('RESULT', await evalJs(`JSON.stringify({ items: document.querySelectorAll('.q-item').length, open: !document.querySelector('[data-reject-box]').classList.contains('hidden'), text: document.querySelector('[data-reject-box] textarea').value })`));
  await shot('30-afkeuren-blijft-open');
  // uploaded file check: in de queue staan nu 2 foto's
  st = await admin('GET', '/api/admin/state');
  console.log('queue', st.queue.length, 'errors', errors.length);
  chrome.kill(); srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('screenshots in', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
