/**
 * Nitrate — ticket orders -> Google Sheet
 *
 * One sheet file, one tab per show. A double header purchase arrives as TWO
 * posts (one per show), so the buyer lands on both tabs, marked "Double header".
 *
 * Setup
 *   1. Create a Google Sheet.
 *   2. Extensions -> Apps Script, paste this file, save.
 *   3. Deploy -> New deployment -> type "Web app"
 *        Execute as:        Me
 *        Who has access:    Anyone
 *   4. Copy the /exec URL, then from the site repo:
 *        npx wrangler secret put ORDERS_SHEET_URL
 *
 * Tabs are created on first order, so nothing needs setting up by hand.
 */

var HEADERS = ['Timestamp', 'Name', 'Email', 'Ticket', 'Qty', 'Amount', 'Order ID'];

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tab = String(d.tab || 'Orders').substring(0, 90);

    var sheet = ss.getSheetByName(tab);
    if (!sheet) {
      sheet = ss.insertSheet(tab);
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // Stripe retries webhooks, so the same order can arrive more than once.
    // Order ID is the last column; skip anything already recorded on this tab.
    var orderId = String(d.orderId || '');
    if (orderId && sheet.getLastRow() > 1) {
      var seen = sheet.getRange(2, HEADERS.length, sheet.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < seen.length; i++) {
        if (String(seen[i][0]) === orderId) {
          return json({ ok: true, duplicate: true });
        }
      }
    }

    sheet.appendRow([
      d.timestamp || new Date().toISOString(),
      d.name || '',
      d.email || '',
      d.ticketType || '',
      d.quantity || 1,
      d.amount || '',
      orderId
    ]);

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
