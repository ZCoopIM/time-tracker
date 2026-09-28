// ---- Settings ----

// The Google Apps Script web app that writes to the sheet (see README.md).
const SHEET_URL = 'https://script.google.com/macros/s/AKfycbyTmXz_Fwydt-RkJQGsrATojgcmHTrcoG_yuFu-J3r4H_hHxYszMn1VwS4GpCT6DbW6Aw/exec';

// Google sign-in: the app's OAuth client ID (see README.md) and the only allowed account domain.
const GOOGLE_CLIENT_ID = '1056506310679-dhv65s90fnc6fjev24va2c6k57n731oj.apps.googleusercontent.com';
const DOMAIN = 'infinitemachine.com';

// The buttons people tap. "Other" asks them to type what they're doing.
const ACTIVITIES = [
  { name: 'QC' },
  { name: 'Fabrication' },
  { name: 'Servicing' },
  { name: 'Transport' },
  { name: 'Other', askForNote: true },
];

// ---- Saved on this device ----
// user:    who is signed in on this device: { name, email, session }
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
  const user = store.get('user', null);
  $('sign-in-screen').hidden = !!user;
  $('main-screen').hidden = !user || viewingDay;
  $('day-screen').hidden = !user || !viewingDay;
  if (!user) return;
  if (viewingDay) renderDay();

  const current = store.get('current', null);
  $('who').textContent = user.name;
  $('sign-out').hidden = !!current;
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
  if (viewingDay) renderDay(); // keeps today's running task counting up
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

// ---- My day ----
// Asks the sheet for one day of the person's check-ins, then adds anything from this
// device that hasn't reached the sheet yet, so it's right even with no signal.

let viewingDay = false;
let dayStart = startOfDay(new Date()); // midnight at the start of the day being shown
let sheetEntries = []; // what the sheet sent back for that day
let dayRequest = 0;    // so a slow answer for a day you've moved away from is ignored

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n); // not + 24 hours, so daylight-saving days still line up
  return d;
}

function openDay(start) {
  viewingDay = true;
  dayStart = start;
  sheetEntries = [];
  render();
  loadDay();
}

async function loadDay() {
  const request = ++dayRequest;
  const user = store.get('user', null);
  $('day-status').textContent = 'Loading';
  try {
    const result = await post({ type: 'day', session: user.session, from: dayStart.toISOString(), to: addDays(dayStart, 1).toISOString() });
    if (request !== dayRequest) return;
    if (result.auth) return signOut();
    if (!result.ok) throw new Error(result.error);
    sheetEntries = result.entries;
    $('day-status').textContent = '';
  } catch (err) {
    if (request !== dayRequest) return;
    console.warn('Could not load the day:', err);
    $('day-status').textContent = "Couldn't reach the sheet. Only showing what's on this device.";
  }
  renderDay();
}

// The day's entries, oldest first: the sheet's, plus check-ins and check-outs still waiting to send.
function dayEntries() {
  const byId = new Map(sheetEntries.map((e) => [e.id, { ...e }]));
  const session = store.get('user', {}).session;
  for (const q of store.get('queue', [])) {
    if (q.session !== session) continue;
    if (q.type === 'in' && !byId.has(q.id)) byId.set(q.id, { id: q.id, activity: q.activity, note: q.note, checkIn: q.time, checkOut: null });
    if (q.type === 'out' && byId.has(q.id)) byId.get(q.id).checkOut = q.time;
  }
  const from = dayStart.getTime(), to = addDays(dayStart, 1).getTime();
  return [...byId.values()]
    .filter((e) => { const t = new Date(e.checkIn).getTime(); return t >= from && t < to; })
    .sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));
}

function renderDay() {
  const today = startOfDay(new Date());
  const current = store.get('current', null);
  const sameYear = dayStart.getFullYear() === today.getFullYear();
  $('day-date').textContent = dayStart.getTime() === today.getTime() ? 'Today'
    : dayStart.getTime() === addDays(today, -1).getTime() ? 'Yesterday'
    : dayStart.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  $('day-next').disabled = dayStart >= today;

  const entries = dayEntries();
  let total = 0;
  const tasks = new Map(); // task name -> milliseconds
  const timeline = [];
  for (const e of entries) {
    const running = !e.checkOut && current && current.id === e.id;
    const end = e.checkOut ? new Date(e.checkOut) : running ? Date.now() : new Date(e.checkIn);
    const ms = Math.max(0, end - new Date(e.checkIn)); // never negative, even if a phone's clock was off
    const name = e.note ? `${e.activity}: ${e.note}` : e.activity;
    total += ms;
    if (e.checkOut || running) tasks.set(name, (tasks.get(name) || 0) + ms); // a forgotten check-out has no time to count
    const until = e.checkOut ? clock(e.checkOut) : running ? 'now' : 'no check-out';
    timeline.push({ name, detail: `${clock(e.checkIn)} – ${until}`, time: running || e.checkOut ? duration(ms) : '', running });
  }

  $('day-total').textContent = duration(total);
  $('day-tasks-block').hidden = !entries.length;
  fillList($('day-tasks'), [...tasks].sort((a, b) => b[1] - a[1]).map(([name, ms]) => ({ name, time: duration(ms) })));
  fillList($('day-entries'), timeline);
  if (!entries.length && !$('day-status').textContent) $('day-status').textContent = 'Nothing logged this day.';
  if (entries.length && $('day-status').textContent === 'Nothing logged this day.') $('day-status').textContent = '';
}

function fillList(list, items) {
  list.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'day-row';
    row.innerHTML = '<div><p class="day-name"></p><p class="day-detail"></p></div><p class="day-time"></p>';
    row.querySelector('.day-name').textContent = item.name;
    row.querySelector('.day-detail').textContent = item.detail || '';
    row.querySelector('.day-detail').hidden = !item.detail;
    row.querySelector('.day-time').textContent = item.time;
    if (item.running) row.querySelector('.day-name').insertAdjacentHTML('afterbegin', '<span class="dot"></span>');
    list.appendChild(row);
  }
}

function clock(time) {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// 2h 05m, or 45m under an hour
function duration(ms) {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
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
  // Each update carries the sign-in of whoever made it, so it's credited to them
  // even if someone else signs in on this device before it's sent.
  queue.push({ ...item, session: store.get('user', {}).session });
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
      const item = queue[0];
      const user = store.get('user', null);
      if (!item.session && !user) break; // wait until someone signs in
      const result = await post({ ...item, session: item.session || user.session });
      if (result.auth) { signOut(); break; } // sign-in no longer valid: keep the queue, ask again
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

async function post(body) {
  const res = await fetch(SHEET_URL, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

function renderSync() {
  const n = store.get('queue', []).length;
  const el = $('sync');
  el.classList.toggle('waiting', n > 0);
  el.textContent = n ? `${n} update${n > 1 ? 's' : ''} waiting to send` : 'All saved';
}

// Retry when the connection comes back, when the app is reopened, and every 30 seconds.
window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { flush(); render(); if (viewingDay) loadDay(); } });
setInterval(flush, 30000);

// ---- Google sign-in ----
// A full-page trip to Google and back (works in iPhone home-screen apps, where pop-ups don't).
// Google returns a signed ID token; the sheet's script checks it and hands back a long-lived
// session, so people stay signed in and entries queued offline still send later.

function signIn() {
  const nonce = crypto.getRandomValues(new Uint32Array(4)).join('-');
  store.set('nonce', nonce);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: location.origin + location.pathname,
    response_type: 'id_token',
    scope: 'openid email profile',
    hd: DOMAIN, // only offer Infinite Machine accounts
    prompt: 'select_account',
    nonce,
  });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
}

async function finishSignIn() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (!hash.has('id_token') && !hash.has('error')) return;
  history.replaceState(null, '', location.pathname); // don't leave the token in the address bar
  if (hash.has('error')) return showSignInError('Sign-in was cancelled.');

  $('sign-in').disabled = true;
  $('sign-in-status').textContent = 'Signing in';
  try {
    const result = await post({ type: 'login', idToken: hash.get('id_token'), nonce: store.get('nonce', '') });
    if (!result.ok) return showSignInError(result.error);
    store.set('user', { name: result.name, email: result.email, session: result.session });
    $('sign-in-status').textContent = '';
    render();
    flush();
  } catch {
    showSignInError('Could not reach the sheet. Check your connection and try again.');
  } finally {
    $('sign-in').disabled = false;
  }
}

function showSignInError(msg) {
  $('sign-in-status').textContent = msg;
}

function signOut() {
  store.set('user', null);
  render();
}

// ---- Buttons ----

$('sign-in').onclick = signIn;
$('sign-out').onclick = signOut;

$('check-out').onclick = checkOut;

$('day-open').onclick = () => openDay(startOfDay(new Date()));
$('day-back').onclick = () => { viewingDay = false; dayRequest++; render(); };
$('day-prev').onclick = () => openDay(addDays(dayStart, -1));
$('day-next').onclick = () => openDay(addDays(dayStart, 1));

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
// Ask the browser not to clear saved data (the sign-in and unsent entries) to free up space.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
store.set('name', null); // left over from the version where people typed their name
render();
finishSignIn();
flush();
