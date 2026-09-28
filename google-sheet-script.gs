/** @OnlyCurrentDoc */ // only lets this script touch this one spreadsheet

// Paste this into the Google Sheet: Extensions → Apps Script. See README.md.
//
// Everything goes in one "Time Log" tab, with a column for who it was. Each check-in
// adds a row; the matching check-out fills in the end time and hours on that same row.
//
// Only people signed in with an Infinite Machine Google account can add entries:
// the app sends Google's sign-in token here once, this script checks it with Google
// and hands back a session that the app includes with every entry.

const LOG_TAB = 'Time Log';
const HEADERS = ['Date', 'Name', 'Email', 'Activity', 'Note', 'Check In', 'Check Out', 'Hours', 'Entry ID'];
const COL = { email: 3, checkIn: 6, checkOut: 7, hours: 8, id: 9 }; // column numbers in HEADERS
const GOOGLE_CLIENT_ID = '1056506310679-dhv65s90fnc6fjev24va2c6k57n731oj.apps.googleusercontent.com'; // same as in app.js
const DOMAIN = 'infinitemachine.com';
const SESSION_DAYS = 365; // how long someone stays signed in on a device

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

  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // one write at a time, so two people tapping at once can't collide
  try {
    if (!d.id || !d.time) throw new Error('Missing id or time');

    const sheet = getLogTab();
    const time = new Date(d.time);
    const row = findRow(sheet, d.id);

    if (d.type === 'in' && !row) { // "!row" means a resent check-in won't be added twice
      addRow(sheet, [time, user.name, user.email, d.activity, d.note || '', time, '', '', d.id]);
    } else if (d.type === 'out' && row) {
      // People can only check out of their own entries. Rows moved over from the old
      // per-person tabs have no email yet, so the first signed-in check-out claims them.
      const owner = sheet.getRange(row, COL.email).getValue();
      if (owner && owner !== user.email) return reply({ ok: true, ignored: true }); // not theirs: drop it, don't retry
      if (!owner) sheet.getRange(row, COL.email).setValue(user.email);
      sheet.getRange(row, COL.checkOut).setValue(time);
      setHours(sheet, row);
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
  for (const [, name, email, activity, note, checkIn, checkOut, , id] of getLogTab().getDataRange().getValues().slice(1)) {
    if (!(checkIn instanceof Date) || checkIn < from || checkIn >= to) continue;
    if (email ? email !== user.email : name !== user.name) continue; // rows moved over from the old per-person tabs have only a name
    entries.push({
      id: String(id),
      activity,
      note,
      checkIn: checkIn.toISOString(),
      checkOut: checkOut instanceof Date ? checkOut.toISOString() : null,
    });
  }
  return { ok: true, entries };
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

function findRow(sheet, id) {
  const cell = sheet.getRange(1, COL.id, sheet.getMaxRows()).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : null;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
