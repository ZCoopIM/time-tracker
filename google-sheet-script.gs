/** @OnlyCurrentDoc */ // only lets this script touch this one spreadsheet

// Paste this into the Google Sheet: Extensions → Apps Script. See README.md.
//
// Everything goes in one "Time Log" tab, with a column for who it was. Each check-in
// adds a row; the matching check-out fills in the end time and hours on that same row.
// Anyone still checked in at 7 PM is checked out at 7 PM and emailed (see autoCheckOut).
// People can fix their own times from the app; the Changes column records every fix.
//
// Only people signed in with an Infinite Machine Google account can add entries:
// the app sends Google's sign-in token here once, this script checks it with Google
// and hands back a session that the app includes with every entry.

const LOG_TAB = 'Time Log';
const HEADERS = ['Date', 'Name', 'Email', 'Activity', 'Note', 'Check In', 'Check Out', 'Hours', 'Entry ID', 'Changes', 'Work Order'];
const COL = { date: 1, email: 3, checkIn: 6, checkOut: 7, hours: 8, id: 9, changes: 10, workOrder: 11 }; // column numbers in HEADERS
const GOOGLE_CLIENT_ID = '1056506310679-dhv65s90fnc6fjev24va2c6k57n731oj.apps.googleusercontent.com'; // same as in app.js
const DOMAIN = 'infinitemachine.com';
const SESSION_DAYS = 365; // how long someone stays signed in on a device
const AUTO_CHECK_OUT_HOUR = 19; // 7 PM, in the script's time zone (Project Settings); same as in app.js
const APP_URL = 'https://timetracker.infinitemachine.com/'; // for the links in the 7 PM email

// Work orders people pick from when they check in to Servicing: the Work Orders table in the
// "Vehicle & Sales Master" Airtable base, only those in these statuses. Needs AIRTABLE_TOKEN in
// Project Settings → Script Properties (see README.md).
const AIRTABLE = {
  base: 'app1hOf3bdBiboN8j',
  table: 'tblk4PnArh2GFQlRh',
  fields: { id: 'fldKQrifloMI9ciHf', status: 'fldy9UMMorhQuA8lk', summary: 'fld3yC8heVVImtVIR', center: 'fldISQeEFWHPBrRgL' },
};
const WORK_ORDER_STATUSES = ['In Service', 'Service Queue']; // listed in this order

function doPost(e) {
  let d;
  try {
    d = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'Bad request' });
  }
  if (d.type === 'login') return reply(login(d));

  const user = readSession(d.session);
  if (!user) return reply({ ok: false, auth: true, error: 'Not signed in' });
  if (d.type === 'day') return reply(day(user, d)); // only reads, so no need to wait for the lock
  if (d.type === 'workOrders') {
    try {
      return reply(workOrders());
    } catch (err) {
      return reply({ ok: false, error: String(err) });
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // one write at a time, so two people tapping at once can't collide
  try {
    if (!d.id || !d.time) throw new Error('Missing id or time');

    const sheet = getLogTab();
    const time = new Date(d.time);
    const row = findRow(sheet, d.id);

    if (d.type === 'in' && !row) { // "!row" means a resent check-in won't be added twice
      addRow(sheet, [time, user.name, user.email, d.activity, d.note || '', time, '', '', d.id, '', d.workOrder || '']);
    } else if (d.type === 'add' && !row) { // time someone forgot to check in for, added from "My day"
      const checkIn = new Date(d.checkIn), checkOut = new Date(d.checkOut);
      if (!(checkOut > checkIn)) return reply({ ok: true, ignored: true }); // the app checks this too; drop it, don't retry
      const added = addRow(sheet, [checkIn, user.name, user.email, d.activity, d.note || '', checkIn, checkOut, '', d.id, 'Added by hand ' + stamp(time), d.workOrder || '']);
      setHours(sheet, added);
    } else if ((d.type === 'out' || d.type === 'edit') && row) {
      // People can only change their own entries. Rows moved over from the old
      // per-person tabs have no email yet, so the first signed-in change claims them.
      const owner = sheet.getRange(row, COL.email).getValue();
      if (owner && owner !== user.email) return reply({ ok: true, ignored: true }); // not theirs: drop it, don't retry
      if (!owner) sheet.getRange(row, COL.email).setValue(user.email);
      if (d.type === 'out') {
        sheet.getRange(row, COL.checkOut).setValue(time);
        setHours(sheet, row);
        if (d.auto) addChange(sheet, row, AUTO_NOTE); // the app got to 7 PM before the hourly run did
      } else {
        const checkIn = new Date(d.checkIn), checkOut = d.checkOut ? new Date(d.checkOut) : null; // none: still checked in
        if (checkOut && !(checkOut > checkIn)) return reply({ ok: true, ignored: true });
        const [wasIn, wasOut] = sheet.getRange(row, COL.checkIn, 1, 2).getValues()[0];
        sheet.getRange(row, COL.date).setValue(checkIn);
        sheet.getRange(row, COL.checkIn).setValue(checkIn);
        if (checkOut) sheet.getRange(row, COL.checkOut).setValue(checkOut);
        if (checkOut || wasOut) setHours(sheet, row);
        addChange(sheet, row, `Edited ${stamp(time)}, was ${clock(wasIn)} to ${wasOut ? clock(wasOut) : 'no check-out'}`);
      }
    }
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// The signed-in person's check-ins between d.from and d.to (the start and end of the day
// in their own time zone), for the app's "My day" screen. Only ever their own rows.
function day(user, d) {
  const from = new Date(d.from), to = new Date(d.to);
  const entries = [];
  for (const [, name, email, activity, note, checkIn, checkOut, , id, , workOrder] of getLogTab().getDataRange().getValues().slice(1)) {
    if (!(checkIn instanceof Date) || checkIn < from || checkIn >= to) continue;
    if (email ? email !== user.email : name !== user.name) continue; // rows moved over from the old per-person tabs have only a name
    entries.push({
      id: String(id),
      activity,
      note,
      workOrder: workOrder || '',
      checkIn: checkIn.toISOString(),
      checkOut: checkOut instanceof Date ? checkOut.toISOString() : null,
    });
  }
  return { ok: true, entries };
}

// ---- Work orders from Airtable ----

// The open work orders for the Servicing list, in Airtable order. Kept for 5 minutes, so tapping
// Servicing is quick and Airtable isn't asked on every tap.
function workOrders() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('workOrders');
  if (cached) return { ok: true, workOrders: JSON.parse(cached) };

  const token = PropertiesService.getScriptProperties().getProperty('AIRTABLE_TOKEN');
  if (!token) return { ok: false, error: "Work orders aren't connected yet." };

  const f = AIRTABLE.fields;
  const list = [];
  for (const r of airtableRecords(token)) {
    const c = r.fields;
    const status = c[f.status] && c[f.status].name ? c[f.status].name : c[f.status];
    if (!WORK_ORDER_STATUSES.includes(status) || !c[f.id]) continue;
    const center = c[f.center] && c[f.center].name ? c[f.center].name : c[f.center];
    list.push({ id: c[f.id], summary: String(c[f.summary] || '').trim(), center: center || '', status, created: r.createdTime });
  }
  list.sort((a, b) => WORK_ORDER_STATUSES.indexOf(a.status) - WORK_ORDER_STATUSES.indexOf(b.status) || (a.created < b.created ? 1 : -1));
  list.forEach((w) => delete w.created);
  cache.put('workOrders', JSON.stringify(list), 300);
  return { ok: true, workOrders: list };
}

// Every Work Orders record in the wanted statuses, with just the fields above. Asks Airtable
// to filter by Status; if that ever fails (say the field is renamed), reads them all instead.
function airtableRecords(token) {
  const f = AIRTABLE.fields;
  const fields = Object.values(f).map((id) => 'fields[]=' + id).join('&');
  const filter = 'filterByFormula=' + encodeURIComponent('OR(' + WORK_ORDER_STATUSES.map((s) => `{Status}='${s}'`).join(',') + ')');
  const read = (query) => {
    const records = [];
    let offset = '';
    do {
      const url = `https://api.airtable.com/v0/${AIRTABLE.base}/${AIRTABLE.table}?returnFieldsByFieldId=true&${fields}&${query}` + (offset ? '&offset=' + offset : '');
      const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error('Airtable ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
      const page = JSON.parse(res.getContentText());
      records.push(...page.records);
      offset = page.offset || '';
    } while (offset);
    return records;
  };
  try {
    return read(filter);
  } catch (err) {
    console.warn('Filtered read failed, reading all work orders:', err);
    return read('pageSize=100');
  }
}

// Pick "checkWorkOrders" next to Run to see the Servicing list the app gets, fresh from
// Airtable, in the Execution log. Handy after changing the token or the statuses.
function checkWorkOrders() {
  CacheService.getScriptCache().remove('workOrders');
  const result = workOrders();
  console.log(result.ok ? result.workOrders.map((w) => `${w.id}  ${w.status}  ${w.center}  ${w.summary}`).join('\n') || 'No work orders in those statuses.' : result.error);
}

// Run this once from the Apps Script editor (pick "addWorkOrderColumn" next to Run) to add the
// Work Order column header to the Time Log tab. Running it again is safe.
function addWorkOrderColumn() {
  getLogTab().getRange(1, COL.workOrder).setValue('Work Order').setFontWeight('bold');
}

// ---- Automatic check-out at 7 PM ----

const AUTO_NOTE = 'Checked out automatically at 7 PM';

// Runs every hour (see setUpAutoCheckOut). Anyone still checked in after 7 PM is checked
// out at 7 PM and emailed, with a link to fix the time if they worked later.
function autoCheckOut() {
  const closed = [];
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const sheet = getLogTab();
    const now = new Date();
    sheet.getDataRange().getValues().forEach(([, , email, activity, note, checkIn, checkOut, , id, , workOrder], i) => {
      if (i === 0 || !(checkIn instanceof Date) || checkOut) return; // header, or already checked out
      const { due, end } = autoCheckOutTime(checkIn);
      if (now < due) return;
      const row = i + 1;
      sheet.getRange(row, COL.checkOut).setValue(end);
      setHours(sheet, row);
      addChange(sheet, row, AUTO_NOTE);
      // Only email about today's. The first run also closes old forgotten entries, quietly.
      if (email && now - due < 864e5) closed.push({ email, activity, note, workOrder, checkIn, end, id: String(id) });
    });
  } finally {
    lock.releaseLock();
  }
  closed.forEach(sendAutoCheckOutEmail);
}

// When an open entry gets closed, and the check-out time it gets: 7 PM that day. Someone who
// checked in after 7 is closed at 7 the next evening with no time counted, for them to fix.
// Same rule as autoCheckOutTime in app.js.
function autoCheckOutTime(checkIn) {
  const at = new Date(checkIn);
  at.setHours(AUTO_CHECK_OUT_HOUR, 0, 0, 0);
  if (checkIn < at) return { due: at, end: at };
  at.setDate(at.getDate() + 1);
  return { due: at, end: new Date(checkIn) };
}

function sendAutoCheckOutEmail(c) {
  const task = (c.workOrder ? `${c.activity} ${c.workOrder}` : c.activity) + (c.note ? `: ${c.note}` : '');
  const at = clock(c.end);
  const day = Utilities.formatDate(c.checkIn, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const edit = `${APP_URL}?edit=${encodeURIComponent(c.id)}&day=${day}`;
  const ok = `${APP_URL}?continue=${encodeURIComponent(c.id)}`;
  const button = (href, label, dark) =>
    `<a href="${href}" style="display:inline-block;padding:14px 24px;margin:0 8px 8px 0;font-size:16px;text-decoration:none;` +
    `background:${dark ? '#000' : '#f0f0f0'};color:${dark ? '#fff' : '#000'}">${label}</a>`;
  MailApp.sendEmail({
    to: c.email,
    name: 'Time Tracker',
    subject: `You were checked out of ${task} at ${at}`,
    body: `You were still checked in to ${task}, so you were checked out automatically at ${at}.\n\n` +
      `If that's right: ${ok}\nIf you worked later, edit your time: ${edit}`,
    htmlBody: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#000;max-width:480px">` +
      `<p style="font-size:18px">You were still checked in to <b>${escapeHtml(task)}</b>, so you were checked out automatically at <b>${at}</b>.</p>` +
      `<p style="font-size:16px;color:#555">If you worked later, edit your time so your hours are right.</p>` +
      button(ok, 'Continue', true) + button(edit, 'Edit my time', false) + `</div>`,
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Run this once from the Apps Script editor (pick "setUpAutoCheckOut" next to Run), and
// approve the permissions it asks for. It runs autoCheckOut every hour and adds the Changes
// column. Running it again is safe. The emails are sent from whoever runs it.
function setUpAutoCheckOut() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'autoCheckOut') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('autoCheckOut').timeBased().everyHours(1).create();
  getLogTab().getRange(1, COL.changes).setValue('Changes').setFontWeight('bold');
}

// Checks Google's sign-in token and, if it's a verified Infinite Machine account,
// returns a signed session holding the person's name and email.
function login(d) {
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(d.idToken || ''), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'Sign-in failed. Please try again.' };
  const t = JSON.parse(res.getContentText()); // Google has checked the signature and expiry
  if (t.aud !== GOOGLE_CLIENT_ID || !d.nonce || t.nonce !== d.nonce) return { ok: false, error: 'Sign-in failed. Please try again.' };
  if (t.hd !== DOMAIN || t.email_verified !== 'true') return { ok: false, error: 'Please sign in with your @' + DOMAIN + ' account.' };

  const user = { name: t.name || t.email.split('@')[0], email: t.email, exp: Date.now() + SESSION_DAYS * 864e5 };
  return { ok: true, name: user.name, email: user.email, session: signSession(user) };
}

// A session is the person's details plus a signature only this script can make,
// so nobody can forge one or change the name inside it.
function signSession(user) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(user));
  return body + '.' + signature(body);
}

function readSession(session) {
  const [body, sig] = String(session || '').split('.');
  if (!body || sig !== signature(body)) return null;
  const user = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString());
  return user.exp > Date.now() ? user : null;
}

function signature(body) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret()));
}

// A random key made the first time it's needed and kept in the script's settings.
// Changing or deleting SESSION_SECRET there signs everyone out.
function secret() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('SESSION_SECRET');
  if (!key) {
    key = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', key);
  }
  return key;
}

// Run this once from the Apps Script editor (pick "authorize" next to Run) after pasting
// the script, so Google asks for permission to check sign-ins.
function authorize() {
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo', { muteHttpExceptions: true });
}

// Visiting the URL in a browser shows this, so you can check it's working.
function doGet() {
  return reply({ ok: true, message: 'Time tracker is running' });
}

function getLogTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_TAB);
  if (sheet) return sheet;

  sheet = ss.insertSheet(LOG_TAB, 0); // first tab
  sheet.appendRow(HEADERS);
  sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.hideColumns(COL.id); // Entry ID is only used to match check-outs to check-ins
  return sheet;
}

function addRow(sheet, values) {
  sheet.appendRow(values);
  const last = sheet.getLastRow(); // appendRow ignores column formats, so set them per row
  sheet.getRange(last, 1).setNumberFormat('ddd m/d/yyyy');
  sheet.getRange(last, COL.checkIn, 1, 2).setNumberFormat('h:mm am/pm');
  sheet.getRange(last, COL.hours).setNumberFormat('0.00');
  return last;
}

function setHours(sheet, row) {
  sheet.getRange(row, COL.hours).setFormula(`=ROUND((G${row}-F${row})*24, 2)`);
}

// One-time move from the old layout (a tab per person) into the Time Log tab.
// Run it from the Apps Script editor (pick "moveTabsIntoLog" next to Run). It copies each
// person's rows in, using the tab name as their name, then deletes the "Setup Test" tab.
// The old per-person tabs are left in place so you can check them before deleting.
function moveTabsIntoLog() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = getLogTab();
  const oldHeaders = ['Date', 'Activity', 'Note', 'Check In', 'Check Out', 'Hours', 'Entry ID'];
  for (const tab of ss.getSheets()) {
    const name = tab.getName();
    if (name === LOG_TAB) continue;
    if (name === 'Setup Test') { ss.deleteSheet(tab); continue; }
    const rows = tab.getDataRange().getValues();
    if (rows.length < 2 || rows[0].join('|') !== oldHeaders.join('|')) continue; // not an old person tab
    for (const [date, activity, note, checkIn, checkOut, , id] of rows.slice(1)) {
      if (findRow(log, id)) continue; // already moved
      const row = addRow(log, [date, name, '', activity, note, checkIn, checkOut, '', id]);
      if (checkOut) setHours(log, row);
    }
  }
}

// Adds a line to the row's Changes cell, so managers can see what was changed and when.
function addChange(sheet, row, text) {
  const cell = sheet.getRange(row, COL.changes);
  const old = String(cell.getValue());
  if (!old.includes(text)) cell.setValue(old ? old + '; ' + text : text);
}

function clock(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'h:mm a');
}

function stamp(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'M/d h:mm a');
}

function findRow(sheet, id) {
  const cell = sheet.getRange(1, COL.id, sheet.getMaxRows()).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : null;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
