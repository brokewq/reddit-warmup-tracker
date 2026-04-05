// ============================================================
// Google Apps Script — Reddit Warmup Tracker Webhook
// Deploy as: Web App → Execute as "Me" → Access "Anyone"
// ============================================================

const AUTH_TOKEN = 'reddit-tracker-2026-xyz'; // Must match extension config

// ---- ENTRY POINTS ----

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.auth_token !== AUTH_TOKEN) {
      return jsonResponse({ status: 'error', message: 'unauthorized' });
    }

    if (!data.reddit_username || !data.date || data.reddit_seconds === undefined) {
      return jsonResponse({ status: 'error', message: 'missing fields' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const accountLabel = lookupAccount(ss, data.reddit_username);

    upsertRawLog(ss, data, accountLabel);
    updateDashboard(ss, data, accountLabel);

    return jsonResponse({ status: 'ok', username: data.reddit_username, account: accountLabel });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'Warmup Tracker webhook is live' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- ACCOUNT LOOKUP (reads from "Account Map" sheet) ----
// To add a new account: just add a row to the Account Map sheet.
// Column A = Reddit Username, Column B = Account Label
// The extension will start tracking it automatically.

function lookupAccount(ss, redditUsername) {
  const sheet = ss.getSheetByName('Account Map');
  if (!sheet) return redditUsername; // fallback to username if no map sheet

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) { // skip header
    if (String(data[i][0]).trim().toLowerCase() === redditUsername.trim().toLowerCase()) {
      return String(data[i][1]).trim() || redditUsername;
    }
  }

  // Username not in map — auto-add it so admin sees it
  sheet.appendRow([redditUsername, redditUsername, 'AUTO-ADDED — set a label']);
  return redditUsername;
}

// ---- RAW LOGS: Upsert row for username+date ----

function upsertRawLog(ss, data, accountLabel) {
  let sheet = ss.getSheetByName('Raw Logs');
  if (!sheet) {
    sheet = ss.insertSheet('Raw Logs');
    sheet.appendRow([
      'Reddit Username', 'Account', 'Date', 'Seconds', 'Time', 'Minutes',
      'First Active', 'Last Active', 'Sessions',
      'Clicks', 'Scrolls', 'Pages',
      'Version', 'Synced At'
    ]);
    sheet.getRange(1, 1, 1, 14).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  const totalSec = data.reddit_seconds || 0;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const timeStr = mins + 'm ' + secs + 's';   // e.g. "17m 13s"
  const minsDec = Math.round((totalSec / 60) * 100) / 100;  // e.g. 17.22 (2 decimals)
  const rowData = [
    data.reddit_username,
    accountLabel,
    data.date,
    data.reddit_seconds,
    timeStr,
    minsDec,
    data.first_active || '',
    data.last_active || '',
    data.session_count || 0,
    data.total_clicks || 0,
    data.total_scrolls || 0,
    data.total_page_navs || 0,
    data.extension_version || '',
    data.timestamp || new Date().toISOString(),
  ];

  // Find existing row for this username + date
  const allData = sheet.getDataRange().getValues();
  let existingRow = -1;
  for (let i = 1; i < allData.length; i++) {
    // FIX: Google Sheets may auto-convert date strings to Date objects
    // Must format them back to yyyy-MM-dd for comparison
    const cellDate = allData[i][2] instanceof Date
      ? Utilities.formatDate(allData[i][2], Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(allData[i][2]);
    if (String(allData[i][0]) === data.reddit_username && cellDate === data.date) {
      existingRow = i + 1;
      break;
    }
  }

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

// ---- DASHBOARD: Update the calendar grid ----

function updateDashboard(ss, data, accountLabel) {
  let sheet = ss.getSheetByName('Dashboard');
  if (!sheet) {
    sheet = createDashboard(ss);
  }

  const totalSec = data.reddit_seconds || 0;
  const minutes = Math.round(totalSec / 60);

  // Find account row (col A, starting row 4)
  const accountCol = sheet.getRange('A4:A100').getValues();
  let accountRow = -1;
  for (let i = 0; i < accountCol.length; i++) {
    if (String(accountCol[i][0]).trim() === '') break; // end of accounts
    if (String(accountCol[i][0]).trim() === accountLabel) {
      accountRow = i + 4;
      break;
    }
  }

  // Account not on dashboard yet — add it
  if (accountRow === -1) {
    accountRow = findLastAccountRow(sheet) + 1;
    sheet.getRange(accountRow, 1).setValue(accountLabel).setFontWeight('bold');
    addSummaryFormulas(sheet, accountRow);
  }

  // Find date column (row 3, starting col B)
  const dateRow = sheet.getRange(3, 2, 1, 31).getValues()[0];
  let dateCol = -1;
  for (let j = 0; j < dateRow.length; j++) {
    const cellVal = dateRow[j];
    let cellDate = '';
    if (cellVal instanceof Date) {
      cellDate = Utilities.formatDate(cellVal, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } else {
      cellDate = String(cellVal);
    }
    if (cellDate === data.date) {
      dateCol = j + 2;
      break;
    }
  }
  if (dateCol === -1) return; // Date not in current month range

  // Write minutes + color
  const cell = sheet.getRange(accountRow, dateCol);
  cell.setValue(minutes).setHorizontalAlignment('center');

  if (minutes >= 15) {
    cell.setBackground('#c6efce').setFontColor('#006100');
  } else if (minutes >= 10) {
    cell.setBackground('#ffeb9c').setFontColor('#9c5700');
  } else if (minutes > 0) {
    cell.setBackground('#ffc7ce').setFontColor('#9c0006');
  }

  // Update TOTAL row
  updateTotalRow(sheet);
}

function findLastAccountRow(sheet) {
  const col = sheet.getRange('A4:A100').getValues();
  for (let i = 0; i < col.length; i++) {
    const val = String(col[i][0]).trim();
    if (val === '' || val === 'TOTAL') return i + 3; // row before empty/TOTAL
  }
  return 16; // default
}

function addSummaryFormulas(sheet, row) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const sumCol = daysInMonth + 2;
  const rangeA1 = sheet.getRange(row, 2, 1, daysInMonth).getA1Notation();

  sheet.getRange(row, sumCol).setFormula('=COUNTIF(' + rangeA1 + ',">=15")');
  sheet.getRange(row, sumCol + 1).setFormula('=IFERROR(AVERAGE(' + rangeA1 + '),0)');
  sheet.getRange(row, sumCol + 2).setFormula('=SUM(' + rangeA1 + ')');
}

function updateTotalRow(sheet) {
  const lastAccRow = findLastAccountRow(sheet);
  const totalRow = lastAccRow + 1;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  sheet.getRange(totalRow, 1).setValue('TOTAL').setFontWeight('bold');

  for (let d = 1; d <= daysInMonth; d++) {
    const col = d + 1;
    const colLetter = columnToLetter(col);
    sheet.getRange(totalRow, col).setFormula(
      '=COUNTIF(' + colLetter + '4:' + colLetter + lastAccRow + ',">=15")&"/"&COUNTA(A4:A' + lastAccRow + ')'
    );
  }
}

// ---- CREATE DASHBOARD ----

function createDashboard(ss) {
  const sheet = ss.insertSheet('Dashboard', 0);

  // Title
  sheet.getRange('A1').setValue('Reddit Warm-Up Tracker')
    .setFontSize(14).setFontWeight('bold').setFontColor('#1a1a2e');
  sheet.getRange('A2').setValue('Green = 15+ min | Yellow = 10-14 min | Red = under 10 min | Blank = no data')
    .setFontSize(9).setFontColor('#666666');

  sheet.getRange('A3').setValue('Account').setFontWeight('bold');

  // Date headers for current month
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (let d = 1; d <= daysInMonth; d++) {
    const col = d + 1;
    const dt = new Date(year, month, d);
    const dateStr = Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const dayName = dayNames[dt.getDay()];

    sheet.getRange(2, col).setValue(dayName).setFontSize(8).setFontColor('#999999')
      .setHorizontalAlignment('center');
    sheet.getRange(3, col).setValue(dateStr).setFontWeight('bold').setFontSize(8)
      .setHorizontalAlignment('center');

    if (dt.getDay() === 0 || dt.getDay() === 6) {
      sheet.getRange(2, col, 50, 1).setBackground('#f5f5f5');
    }
  }

  // Summary column headers
  const sumCol = daysInMonth + 2;
  sheet.getRange(3, sumCol).setValue('Days OK').setFontWeight('bold').setFontSize(8).setHorizontalAlignment('center');
  sheet.getRange(3, sumCol + 1).setValue('Avg Min').setFontWeight('bold').setFontSize(8).setHorizontalAlignment('center');
  sheet.getRange(3, sumCol + 2).setValue('Total Min').setFontWeight('bold').setFontSize(8).setHorizontalAlignment('center');

  // Pre-fill accounts from Account Map sheet
  const mapSheet = ss.getSheetByName('Account Map');
  if (mapSheet) {
    const mapData = mapSheet.getDataRange().getValues();
    for (let i = 1; i < mapData.length; i++) {
      const label = String(mapData[i][1]).trim();
      if (!label) continue;
      const row = i + 3;
      sheet.getRange(row, 1).setValue(label).setFontWeight('bold');
      addSummaryFormulas(sheet, row);
    }
    updateTotalRow(sheet);
  }

  // Formatting
  sheet.setColumnWidth(1, 90);
  for (let d = 1; d <= daysInMonth; d++) {
    sheet.setColumnWidth(d + 1, 52);
  }
  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(1);

  return sheet;
}

// ---- UTILITY ----

function columnToLetter(col) {
  let letter = '';
  while (col > 0) {
    let mod = (col - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    col = Math.floor((col - mod) / 26);
  }
  return letter;
}

// ---- SETUP: Run this once from the Apps Script editor ----

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create Account Map if missing
  if (!ss.getSheetByName('Account Map')) {
    const am = ss.insertSheet('Account Map');
    am.appendRow(['Reddit Username', 'Account Label', 'Notes']);
    am.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#e8e8e8');
    am.setFrozenRows(1);
    am.setColumnWidth(1, 220);
    am.setColumnWidth(2, 120);
    am.setColumnWidth(3, 250);
    am.getRange('A2').setNote('Add new accounts here. Just fill Reddit Username + Label. The extension handles the rest.');
  }

  // Create Raw Logs if missing
  if (!ss.getSheetByName('Raw Logs')) {
    const rl = ss.insertSheet('Raw Logs');
    rl.appendRow([
      'Reddit Username', 'Account', 'Date', 'Seconds', 'Time', 'Minutes',
      'First Active', 'Last Active', 'Sessions',
      'Clicks', 'Scrolls', 'Pages',
      'Version', 'Synced At'
    ]);
    rl.getRange(1, 1, 1, 14).setFontWeight('bold').setBackground('#e8e8e8');
    rl.setFrozenRows(1);
  }

  // Create Dashboard
  if (!ss.getSheetByName('Dashboard')) {
    createDashboard(ss);
  }

  SpreadsheetApp.getUi().alert(
    'Setup complete!\n\n' +
    '1. Go to "Account Map" sheet and add your Reddit usernames + labels\n' +
    '2. Deploy this script as a Web App\n' +
    '3. Paste the Web App URL into the extension\'s background.js'
  );
}

// ---- MONTHLY RESET: Run this on the 1st of each month ----
// Or set a time-driven trigger to run it automatically

function resetDashboardForNewMonth() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const old = ss.getSheetByName('Dashboard');
  if (old) {
    // Rename old dashboard with month label
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthName = Utilities.formatDate(prevMonth, Session.getScriptTimeZone(), 'MMM yyyy');
    old.setName('Dashboard — ' + monthName);
  }
  createDashboard(ss);
}
