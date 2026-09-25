// ---- Settings: the only two things you should need to change ----

// Paste the Google Apps Script web app URL here (see README.md).
const SHEET_URL = 'https://script.google.com/macros/s/AKfycbw--_Xjc6FGlAjxhGxaKsaCZ_JVxIK0EUxNJpz_ZOoZwVtgBnuGb2H4F5HhhtNjwVt40Q/exec';

// The buttons people tap. "Other" asks them to type what they're doing.
const ACTIVITIES = [
  { name: 'QC' },
  { name: 'Fabrication' },
  { name: 'Servicing' },
  { name: 'Transport' },
  { name: 'Other', askForNote: true },
];

// ---- Saved on this device ----
// name:    who is using this device
// current: what they're checked in to right now, or null
// queue:   check-ins/outs not yet confirmed by the Google Sheet (e.g. while offline)

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

const $ = (id) => document.getElementById(id);

// ---- Screens ----

function render() {
  const name = store.get('name', '');
  $('name-screen').hidden = !!name;
  $('main-screen').hidden = !name;
  if (!name) {
    $('name-input').focus();
    return;
  }

  const current = store.get('current', null);
  $('who').textContent = name;
  $('change-name').hidden = !!current;
  $('current').hidden = !current;
  $('prompt').textContent = current ? 'Switch task' : 'Select task';

  if (current) {
    $('current-activity').textContent = current.note ? `${current.activity}: ${current.note}` : current.activity;
    $('current-since').textContent = 'Since ' + new Date(current.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    tick();
  }

  const list = $('activities');
  list.innerHTML = '';
  for (const a of ACTIVITIES) {
    if (current && current.activity === a.name && !a.askForNote) continue; // already doing this one
    const b = document.createElement('button');
    b.className = 'row';
    b.innerHTML = '<span></span><svg class="chevron" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6"/></svg>';
    b.firstChild.textContent = a.name;
    b.onclick = () => (a.askForNote ? showOtherForm() : checkIn(a.name, ''));
    list.appendChild(b);
  }
  renderSync();
}

function tick() {
  const current = store.get('current', null);
  if (!current) return;
  const secs = Math.max(0, Math.floor((Date.now() - new Date(current.time)) / 1000));
  const h = Math.floor(secs / 3600);
  const m = String(Math.floor(secs / 60) % 60).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  $('current-timer').textContent = `${h}:${m}:${s}`;
}
setInterval(tick, 1000);

function showOtherForm() {
  $('activities').hidden = true;
  $('other-form').hidden = false;
  $('other-input').value = '';
  $('other-input').focus();
}

function hideOtherForm() {
  $('activities').hidden = false;
  $('other-form').hidden = true;
}

// ---- Check in / check out ----

function checkIn(activity, note) {
  checkOut(); // switching activities ends the current one first
  const entry = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), activity, note, time: new Date().toISOString() };
  store.set('current', entry);
  send({ type: 'in', ...entry });
  render();
}

function checkOut() {
  const current = store.get('current', null);
  if (!current) return;
  store.set('current', null);
  send({ type: 'out', id: current.id, activity: current.activity, time: new Date().toISOString() });
  render();
}

// ---- Sending to the Google Sheet ----
// Everything goes into a queue first, so nothing is lost if there's no signal.
// The queue is sent in order, and each item is removed only once the sheet confirms it.

function send(item) {
  const queue = store.get('queue', []);
  queue.push({ ...item, name: store.get('name', '') });
  store.set('queue', queue);
  flush();
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    let queue = store.get('queue', []);
    while (queue.length) {
      const res = await fetch(SHEET_URL, { method: 'POST', body: JSON.stringify(queue[0]) });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error);
      queue = store.get('queue', []);
      queue.shift();
      store.set('queue', queue);
      renderSync();
    }
  } catch (err) {
    console.warn('Will retry sending later:', err);
  } finally {
    flushing = false;
    renderSync();
  }
}

function renderSync() {
  const n = store.get('queue', []).length;
  const el = $('sync');
  el.classList.toggle('waiting', n > 0);
  el.textContent = n ? `${n} update${n > 1 ? 's' : ''} waiting to send` : 'All saved';
}

// Retry when the connection comes back, when the app is reopened, and every 30 seconds.
window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { flush(); render(); } });
setInterval(flush, 30000);

// ---- Buttons ----

$('name-form').onsubmit = (e) => {
  e.preventDefault();
  // Tidy the name so "zach  cooper" and "Zach Cooper" land on the same sheet tab.
  const name = $('name-input').value.trim().replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  if (!name) return;
  store.set('name', name);
  render();
};

$('change-name').onclick = () => {
  store.set('name', '');
  $('name-input').value = '';
  render();
};

$('check-out').onclick = checkOut;

$('other-form').onsubmit = (e) => {
  e.preventDefault();
  const note = $('other-input').value.trim();
  if (!note) return;
  hideOtherForm();
  checkIn('Other', note);
};
$('other-cancel').onclick = hideOtherForm;

// ---- Start ----

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
// Ask the browser not to clear saved data (the name and unsent entries) to free up space.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
render();
flush();
