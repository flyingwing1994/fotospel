// Gedeelde hulpjes voor spelers- en beheerapp.
'use strict';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#888888'; }

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch { throw new Error('Geen verbinding. Probeer het opnieuw.'); }
  let data = {};
  try { data = await res.json(); } catch { /* geen json */ }
  if (!res.ok) { const e = new Error(data.error || `Fout ${res.status}`); e.status = res.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), bad ? 4500 : 2500);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}
function fmtTime(ms) { return new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }); }
function fmtDateTime(ms) { return new Date(ms).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

// Live updates: bij elk 'refresh'-bericht opnieuw laden (met kleine vertraging om te bundelen).
function liveUpdates(onRefresh) {
  let es, timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(onRefresh, 250); };
  const connect = () => {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.onmessage = schedule;
    es.onopen = () => { document.body.classList.remove('is-offline'); schedule(); };
    es.onerror = () => document.body.classList.add('is-offline');
  };
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (!es || es.readyState === 2) connect(); schedule(); }
  });
  setInterval(() => { if (es && es.readyState === 2) connect(); }, 10000);
}

function lightbox(src, caption) {
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = `<img src="${esc(src)}" alt=""><p>${esc(caption || '')}</p><p class="small" style="opacity:.7">Tik om te sluiten</p>`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}

// Meldingen bovenin beeld. kind: 'good' | 'bad' | 'warn' | '' ; sticky = blijft staan tot je tikt.
function notify(msg, kind = '', sticky = false) {
  let host = document.getElementById('notify-host');
  if (!host) { host = document.createElement('div'); host.id = 'notify-host'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = 'notify ' + kind;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(msg)}</span><button aria-label="Sluiten">×</button>`;
  const remove = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.onclick = remove;
  host.prepend(el);
  while (host.children.length > 4) host.lastChild.remove();
  if (!sticky) setTimeout(remove, kind === 'bad' ? 15000 : 8000);
  try { navigator.vibrate?.(kind === 'bad' ? [200, 100, 200] : 120); } catch { /* niet ondersteund */ }
}
function loadJson(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function saveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* geen opslag */ } }
