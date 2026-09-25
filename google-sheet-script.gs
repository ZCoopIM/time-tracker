// Paste this into the Google Sheet: Extensions → Apps Script. See README.md.
//
// Each person gets their own tab, named after them. Each check-in adds a row;
// the matching check-out fills in the end time and hours on that same row.

const HEADERS = ['Date', 'Activity', 'Note', 'Check In', 'Check Out', 'Hours', 'Entry ID'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // one write at a time, so two people tapping at once can't collide
  try {
    const d = JSON.parse(e.postData.contents);
    const name = String(d.name || '').replace(/[\[\]*?/\\:]/g, '').trim().slice(0, 90);
    if (!name || !d.id || !d.time) throw new Error('Missing name, id or time');

    const sheet = getOrCreateTab(name);
    const time = new Date(d.time);
    const row = findRow(sheet, d.id);

    if (d.type === 'in' && !row) { // "!row" means a resent check-in won't be added twice
      sheet.appendRow([time, d.activity, d.note || '', time, '', '', d.id]);
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
