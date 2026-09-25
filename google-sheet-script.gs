/** @OnlyCurrentDoc */ // only lets this script touch this one spreadsheet

// Paste this into the Google Sheet: Extensions → Apps Script. See README.md.
//
// Each person gets their own tab, named after them. Each check-in adds a row;
// the matching check-out fills in the end time and hours on that same row.
//
// Only people signed in with an Infinite Machine Google account can add entries:
// the app sends Google's sign-in token here once, this script checks it with Google
// and hands back a session that the app includes with every entry.

const HEADERS = ['Date', 'Activity', 'Note', 'Check In', 'Check Out', 'Hours', 'Entry ID'];
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

  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // one write at a time, so two people tapping at once can't collide
  try {
    const name = String(user.name).replace(/[\[\]*?/\\:]/g, '').trim().slice(0, 90);
    if (!name || !d.id || !d.time) throw new Error('Missing name, id or time');

    const sheet = getOrCreateTab(name);
    const time = new Date(d.time);
    const row = findRow(sheet, d.id);

    if (d.type === 'in' && !row) { // "!row" means a resent check-in won't be added twice
      sheet.appendRow([time, d.activity, d.note || '', time, '', '', d.id]);
      const last = sheet.getLastRow(); // appendRow ignores column formats, so set them per row
      sheet.getRange(last, 1).setNumberFormat('ddd m/d/yyyy');
      sheet.getRange(last, 4, 1, 2).setNumberFormat('h:mm am/pm');
    } else if (d.type === 'out' && row) {
      sheet.getRange(row, 5).setValue(time);
      sheet.getRange(row, 6).setFormula(`=ROUND((E${row}-D${row})*24, 2)`);
    }
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
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

function getOrCreateTab(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  sheet = ss.insertSheet(name);
  sheet.appendRow(HEADERS);
  sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('ddd m/d/yyyy');
  sheet.getRange('D:E').setNumberFormat('h:mm am/pm');
  sheet.getRange('F:F').setNumberFormat('0.00');
  sheet.hideColumns(7); // Entry ID is only used to match check-outs to check-ins
  return sheet;
}

function findRow(sheet, id) {
  const cell = sheet.getRange('G:G').createTextFinder(String(id)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : null;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
