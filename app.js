// ---- Settings ----

// The Google Apps Script web app that writes to the sheet (see README.md).
const SHEET_URL = 'https://script.google.com/macros/s/AKfycbyTmXz_Fwydt-RkJQGsrATojgcmHTrcoG_yuFu-J3r4H_hHxYszMn1VwS4GpCT6DbW6Aw/exec';

// Google sign-in: the app's OAuth client ID (see README.md) and the only allowed account domain.
const GOOGLE_CLIENT_ID = '1056506310679-dhv65s90fnc6fjev24va2c6k57n731oj.apps.googleusercontent.com';
const DOMAIN = 'infinitemachine.com';

// The buttons people tap. "Other" asks them to type what they're doing; "Servicing" asks which
// work order (from Airtable, through the sheet's script).
const ACTIVITIES = [
  { name: 'QC' },
  { name: 'Fabrication' },
  { name: 'Servicing', askForWorkOrder: true },
  { name: 'Transport' },
  { name: 'Other', askForNote: true },
];

// Anyone still checked in at this hour (7 PM) is checked out at it. Same as in google-sheet-script.gs.
const AUTO_CHECK_OUT_HOUR = 19;

// ---- Saved on this device ----
// user:    who is signed in on this device: { name, email, session }
// current: what they're checked in to right now, or null
// queue:   check-ins/outs and time fixes not yet confirmed by the Google Sheet (e.g. while offline)
// notice:  the 7 PM automatic check-out to tell them about, or null
// workOrders: the last list of open work orders, so Servicing works with no signal

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
  autoCheckOut();
  if (viewingDay) renderDay();

  const current = store.get('current', null);
  const notice = store.get('notice', null);
  $('notice').hidden = !notice;
  if (notice) {
    const day = startOfDay(notice.checkIn).getTime() === startOfDay(new Date()).getTime() ? '' : ' on ' + shortDate(notice.checkIn);
    $('notice-text').textContent = `You were still checked in to ${taskName(notice)}, so you were checked out at ${clock(notice.end)}${day}. If you worked later, fix your time.`;
  }
  $('who').textContent = user.name;
  $('sign-out').hidden = !!current;
  $('current').hidden = !current;
  $('prompt').textContent = current ? 'Switch task' : 'Select task';

  if (current) {
    $('current-activity').textContent = taskName(current);
    $('current-since').textContent = 'Since ' + new Date(current.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    tick();
  }

  const list = $('activities');
  list.innerHTML = '';
  for (const a of ACTIVITIES) {
    if (current && current.activity === a.name && !a.askForNote && !a.askForWorkOrder) continue; // already doing this one
    const b = document.createElement('button');
    b.className = 'row';
    b.innerHTML = '<span></span><svg class="chevron" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6"/></svg>';
    b.firstChild.textContent = a.name;
    b.onclick = () => (a.askForNote ? showOtherForm() : a.askForWorkOrder ? showWorkOrders() : checkIn(a.name, ''));
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
  const mins = Math.floor(secs / 60);
  if (viewingDay && !editing && mins !== dayMinute) { dayMinute = mins; renderDay(); } // keeps today's running task counting up
}
setInterval(() => { if (autoCheckOut()) render(); tick(); }, 1000);

// ---- Automatic check-out at 7 PM ----
// The sheet does this too, every hour, and emails them, so it happens even with the app
// closed. This keeps the phone in step and shows the message when the app is next opened.

// When an open entry gets closed, and the check-out time it gets: 7 PM that day. Someone who
// checked in after 7 is closed at 7 the next evening with no time counted, for them to fix.
function autoCheckOutTime(checkIn) {
  const start = new Date(checkIn);
  const at = new Date(start);
  at.setHours(AUTO_CHECK_OUT_HOUR, 0, 0, 0);
  if (start < at) return { due: at, end: at };
  return { due: addDays(at, 1), end: start };
}

// Checks them out if it's past 7. Returns true if it did.
function autoCheckOut() {
  const current = store.get('current', null);
  if (!current) return false;
  const { due, end } = autoCheckOutTime(current.time);
  if (Date.now() < due) return false;
  store.set('current', null);
  store.set('notice', { id: current.id, activity: current.activity, note: current.note, workOrder: current.workOrder, checkIn: current.time, end: end.toISOString() });
  send({ type: 'out', id: current.id, activity: current.activity, time: end.toISOString(), auto: true });
  return true;
}

// "QC", "Other: Cleaning shop", "Servicing IM-WO-26-0688"
function taskName(entry) {
  return (entry.workOrder ? `${entry.activity} ${entry.workOrder}` : entry.activity) + (entry.note ? `: ${entry.note}` : '');
}

function shortDate(time) {
  return new Date(time).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

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

// ---- Servicing: pick a work order ----
// Shows the last list saved on the phone straight away, then the fresh one from Airtable.

function showWorkOrders() {
  $('activities').hidden = true;
  $('prompt').hidden = true;
  $('day-open').hidden = true;
  $('work-order-picker').hidden = false;
  renderWorkOrders();
  $('work-order-status').textContent = 'Loading work orders';
  loadWorkOrders().then((error) => {
    $('work-order-status').textContent = error && store.get('workOrders', []).length ? "Couldn't refresh the list. This is the last one saved."
      : error ? "Couldn't load work orders. Use \"Not on the list\" for now." : '';
    if (!$('work-order-picker').hidden) renderWorkOrders();
  });
}

function hideWorkOrders() {
  $('activities').hidden = false;
  $('prompt').hidden = false;
  $('day-open').hidden = false;
  $('work-order-picker').hidden = true;
}

// Fetches the list from the sheet's script and saves it. Returns an error message, or '' if it worked.
async function loadWorkOrders() {
  const user = store.get('user', null);
  if (!user) return 'Not signed in';
  try {
    const result = await post({ type: 'workOrders', session: user.session });
    if (result.auth) { signOut(); return 'Not signed in'; }
    if (!result.ok) throw new Error(result.error);
    store.set('workOrders', result.workOrders);
    fillWorkOrderSelect();
    return '';
  } catch (err) {
    console.warn('Could not load work orders:', err);
    return String(err.message || err);
  }
}

function renderWorkOrders() {
  const list = $('work-order-list');
  list.innerHTML = '';
  for (const w of store.get('workOrders', [])) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day-row';
    b.innerHTML = '<div><p class="day-name"></p><p class="day-detail"></p></div><svg class="chevron" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6"/></svg>';
    b.querySelector('.day-name').textContent = w.id;
    b.querySelector('.day-detail').textContent = [w.summary, w.center, w.status].filter(Boolean).join(' · ');
    b.onclick = () => { hideWorkOrders(); checkIn('Servicing', '', w.id); };
    list.appendChild(b);
  }
}

// The work order choices in the "add time" form
function fillWorkOrderSelect() {
  const select = $('edit-work-order');
  const chosen = select.value;
  select.innerHTML = '<option value="">No work order</option>';
  for (const w of store.get('workOrders', [])) {
    const o = document.createElement('option');
    o.value = w.id;
    o.textContent = w.summary ? `${w.id} · ${w.summary}` : w.id;
    select.appendChild(o);
  }
  select.value = chosen;
}

// ---- My day ----
// Asks the sheet for one day of the person's check-ins, then adds anything from this
// device that hasn't reached the sheet yet, so it's right even with no signal.

let viewingDay = false;
let dayStart = startOfDay(new Date()); // midnight at the start of the day being shown
let sheetEntries = []; // what the sheet sent back for that day
let dayRequest = 0;    // so a slow answer for a day you've moved away from is ignored
let dayMinute = -1;    // the running task's minute last shown, so the list redraws once a minute
let editing = null;    // the entry being fixed, or {} when adding a missed one
let editWhenLoaded = null; // entry to open for fixing once the day loads (from the 7 PM email or message)

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

function openDay(start, editId = null) {
  viewingDay = true;
  dayStart = start;
  sheetEntries = [];
  editWhenLoaded = editId;
  closeEditor();
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
  const entry = editWhenLoaded && dayEntries().find((e) => e.id === editWhenLoaded);
  editWhenLoaded = null;
  if (entry) openEditor(entry);
}

// The day's entries, oldest first: the sheet's, plus changes still waiting to send.
function dayEntries() {
  const byId = new Map(sheetEntries.map((e) => [e.id, { ...e }]));
  const session = store.get('user', {}).session;
  for (const q of store.get('queue', [])) {
    if (q.session !== session) continue;
    const e = byId.get(q.id);
    if (q.type === 'in' && !e) byId.set(q.id, { id: q.id, activity: q.activity, note: q.note, workOrder: q.workOrder, checkIn: q.time, checkOut: null });
    if (q.type === 'add' && !e) byId.set(q.id, { id: q.id, activity: q.activity, note: q.note, workOrder: q.workOrder, checkIn: q.checkIn, checkOut: q.checkOut });
    if (q.type === 'out' && e) e.checkOut = q.time;
    if (q.type === 'edit' && e) { e.checkIn = q.checkIn; if (q.checkOut) e.checkOut = q.checkOut; }
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
    const name = taskName(e);
    total += ms;
    if (e.checkOut || running) tasks.set(name, (tasks.get(name) || 0) + ms); // a forgotten check-out has no time to count
    const until = e.checkOut ? clock(e.checkOut) : running ? 'now' : 'no check-out';
    timeline.push({ name, detail: `${clock(e.checkIn)} – ${until}`, time: running || e.checkOut ? duration(ms) : '', running, onClick: () => openEditor(e) });
  }

  $('day-total').textContent = duration(total);
  $('day-tasks-block').hidden = !entries.length;
  fillList($('day-tasks'), [...tasks].sort((a, b) => b[1] - a[1]).map(([name, ms]) => ({ name, time: duration(ms) })));
  fillList($('day-entries'), timeline);
  $('day-add').hidden = dayStart > today;
  if (!entries.length && !$('day-status').textContent) $('day-status').textContent = 'Nothing logged this day.';
  if (entries.length && $('day-status').textContent === 'Nothing logged this day.') $('day-status').textContent = '';
}

function fillList(list, items) {
  list.innerHTML = '';
  for (const item of items) {
    const row = document.createElement(item.onClick ? 'button' : 'div');
    row.className = 'day-row';
    row.innerHTML = '<div><p class="day-name"></p><p class="day-detail"></p></div><p class="day-time"></p>';
    if (item.onClick) {
      row.type = 'button';
      row.onclick = item.onClick;
      row.insertAdjacentHTML('beforeend', '<svg class="chevron" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6"/></svg>');
    }
    row.querySelector('.day-name').textContent = item.name;
    row.querySelector('.day-detail').textContent = item.detail || '';
    row.querySelector('.day-detail').hidden = !item.detail;
    row.querySelector('.day-time').textContent = item.time;
    if (item.running) row.querySelector('.day-name').insertAdjacentHTML('afterbegin', '<span class="dot"></span>');
    list.appendChild(row);
  }
}

// ---- Fixing a time ----
// Tap an entry in the timeline to change its check-in or check-out (forgot to check out,
// worked past 7), or add time you forgot to check in for. Only the day being shown.

function openEditor(entry) {
  editing = entry;
  const adding = !entry.id;
  const running = isRunning(entry);
  $('day-view').hidden = true;
  document.querySelector('.day-nav').hidden = true;
  $('edit-form').hidden = false;
  $('edit-title').textContent = adding ? `Add time · ${$('day-date').textContent}` : `${taskName(entry)} · ${$('day-date').textContent}`;
  $('edit-task-fields').hidden = !adding;
  $('edit-activity').value = ACTIVITIES[0].name;
  $('edit-note').value = '';
  fillWorkOrderSelect();
  $('edit-work-order').value = '';
  showTaskExtras();
  $('edit-out-field').hidden = running; // still checked in: only the start can change
  $('edit-in').value = adding ? '' : timeValue(entry.checkIn);
  $('edit-out').value = adding || !entry.checkOut ? '' : timeValue(entry.checkOut);
  $('edit-error').textContent = '';
  window.scrollTo(0, 0);
}

function closeEditor() {
  editing = null;
  $('day-view').hidden = false;
  document.querySelector('.day-nav').hidden = false;
  $('edit-form').hidden = true;
}

function isRunning(entry) {
  const current = store.get('current', null);
  return !!entry.id && !entry.checkOut && !!current && current.id === entry.id;
}

function saveEdit() {
  const adding = !editing.id;
  const running = isRunning(editing);
  const checkIn = atTime(dayStart, $('edit-in').value);
  const checkOut = running ? null : atTime(dayStart, $('edit-out').value);
  const activity = adding ? $('edit-activity').value : editing.activity;
  const task = ACTIVITIES.find((a) => a.name === activity) || {};
  const note = adding ? (task.askForNote ? $('edit-note').value.trim() : '') : editing.note;
  const workOrder = adding ? (task.askForWorkOrder ? $('edit-work-order').value : '') : editing.workOrder || '';

  const error = !checkIn ? 'Enter a check-in time.'
    : !running && !checkOut ? 'Enter a check-out time.'
    : checkOut && checkOut <= checkIn ? 'Check-out has to be after check-in.'
    : (checkOut || checkIn) > Date.now() + 60000 ? "That time hasn't happened yet."
    : adding && activity === 'Other' && !note ? 'Say what you were working on.'
    : '';
  $('edit-error').textContent = error;
  if (error) return;

  const entry = { ...editing, id: adding ? newId() : editing.id, activity, note, workOrder, checkIn: checkIn.toISOString(), checkOut: checkOut && checkOut.toISOString() };
  send({ type: adding ? 'add' : 'edit', id: entry.id, activity, note, workOrder, checkIn: entry.checkIn, checkOut: entry.checkOut, time: new Date().toISOString() });
  sheetEntries = [...sheetEntries.filter((e) => e.id !== entry.id), entry]; // show it now, without waiting for the sheet
  if (running) store.set('current', { ...store.get('current', null), time: entry.checkIn }); // the timer starts from the fixed time
  closeEditor();
  render();
}

// "14:30" on the given day, as a date. Empty gives null.
function atTime(day, value) {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

// A date's time as "14:30", for the time inputs
function timeValue(time) {
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

function checkIn(activity, note, workOrder = '') {
  checkOut(); // switching activities ends the current one first
  const entry = { id: newId(), activity, note, workOrder, time: new Date().toISOString() };
  store.set('current', entry);
  send({ type: 'in', ...entry });
  render();
}

function checkOut() {
  if (autoCheckOut()) return render(); // past 7 PM: that's when they were checked out
  const current = store.get('current', null);
  if (!current) return;
  store.set('current', null);
  send({ type: 'out', id: current.id, activity: current.activity, time: new Date().toISOString() });
  render();
}

function newId() {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 8);
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
$('day-back').onclick = () => {
  if (editing) return closeEditor(); // Back from the edit form goes to the day, not all the way out
  viewingDay = false;
  dayRequest++;
  render();
};
$('day-prev').onclick = () => openDay(addDays(dayStart, -1));
$('day-next').onclick = () => openDay(addDays(dayStart, 1));

$('day-add').onclick = () => openEditor({});
$('edit-form').onsubmit = (e) => { e.preventDefault(); saveEdit(); };
$('edit-cancel').onclick = closeEditor;
$('edit-activity').innerHTML = ACTIVITIES.map((a) => `<option>${a.name}</option>`).join('');
// In the "add time" form: Other asks what it was, Servicing asks which work order.
function showTaskExtras() {
  const task = ACTIVITIES.find((a) => a.name === $('edit-activity').value) || {};
  $('edit-note').hidden = !task.askForNote;
  $('edit-work-order').hidden = !task.askForWorkOrder;
  if (task.askForWorkOrder) loadWorkOrders(); // freshen the choices if there's signal
}
$('edit-activity').onchange = showTaskExtras;

$('work-order-none').onclick = () => { hideWorkOrders(); checkIn('Servicing', ''); };
$('work-order-cancel').onclick = hideWorkOrders;

$('notice-continue').onclick = () => { store.set('notice', null); render(); };
$('notice-edit').onclick = () => {
  const notice = store.get('notice', null);
  store.set('notice', null);
  openDay(startOfDay(notice.checkIn), notice.id);
};

// Links in the 7 PM email: ?continue=<entry> just clears the message; ?edit=<entry>&day=2026-09-28
// opens that entry for fixing.
function openEmailLink() {
  const params = new URLSearchParams(location.search);
  const id = params.get('edit') || params.get('continue');
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  if ((store.get('notice', null) || {}).id === id) store.set('notice', null);
  const [y, m, d] = (params.get('day') || '').split('-').map(Number);
  if (params.has('edit') && store.get('user', null)) openDay(y ? new Date(y, m - 1, d) : startOfDay(new Date()), id);
  else render();
}

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
openEmailLink();
finishSignIn();
flush();
loadWorkOrders(); // so the Servicing list is ready, and saved for when there's no signal
