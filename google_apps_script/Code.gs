/**
 * Trip Planner Bridge
 * A minimal JSON endpoint so Claude can read and write your travel sheets
 * without your laptop needing to be on.
 *
 * SETUP
 *   1. Open your Planner sheet -> Extensions -> Apps Script
 *   2. Delete the placeholder code, paste this whole file in
 *   3. Change TOKEN below to a long random string of your own
 *   4. Deploy -> New deployment -> type: Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      ("Anyone" is required for a server to reach it. The TOKEN is what
 *       actually protects it — that is why it must not be guessable.)
 *   5. Authorise when prompted, then copy the /exec URL
 *
 * SECURITY NOTES
 *   - This endpoint can ONLY touch the spreadsheets listed in ALLOWED below.
 *     It is not a general key to your Drive.
 *   - Reads are unrestricted; writes are capped at MAX_CELLS per call.
 *   - Revoke at any time: Deploy -> Manage deployments -> Archive.
 *   - Rotate by changing TOKEN and redeploying.
 */

// ---------------------------------------------------------------- config

const TOKEN = '';

const ALLOWED = {
  planner: '',
  dummy:   '' 
};

const MAX_CELLS = 5000;   // guard against a runaway write
const LOG_TAB   = null;   // set to a tab name (e.g. '_log') to record every write

// ---------------------------------------------------------------- routing

function doGet() {
  return json({
    ok: true,
    service: 'trip-planner-bridge',
    note: 'Alive. POST a JSON body with a valid token to use.'
  });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty request body' });
    }

    var req;
    try {
      req = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return json({ ok: false, error: 'body was not valid JSON' });
    }

    if (!req.token || req.token !== TOKEN) {
      return json({ ok: false, error: 'bad or missing token' });
    }

    var book = req.book || 'planner';
    var id = ALLOWED[book];
    if (!id) {
      return json({
        ok: false,
        error: 'unknown book: ' + book,
        allowed: Object.keys(ALLOWED)
      });
    }

    var ss = SpreadsheetApp.openById(id);

    switch (req.op) {
      case 'ping':   return json(opPing(ss, book));
      case 'read':   return json(opRead(ss, req));
      case 'write':  return json(opWrite(ss, req));
      case 'append': return json(opAppend(ss, req));
      default:
        return json({
          ok: false,
          error: 'unknown op: ' + req.op,
          ops: ['ping', 'read', 'write', 'append']
        });
    }

  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// ---------------------------------------------------------------- ops

/** List the tabs and their dimensions. Use this to orient before reading. */
function opPing(ss, book) {
  return {
    ok: true,
    book: book,
    title: ss.getName(),
    url: ss.getUrl(),
    tabs: ss.getSheets().map(function (s) {
      return {
        name: s.getName(),
        rows: s.getLastRow(),
        cols: s.getLastColumn()
      };
    })
  };
}

/**
 * read  { tab, range? }
 * Omit range to get the whole used area of the tab.
 */
function opRead(ss, req) {
  var sheet = mustGetTab(ss, req.tab);
  var rng = req.range ? sheet.getRange(req.range) : sheet.getDataRange();

  return {
    ok: true,
    tab: sheet.getName(),
    range: rng.getA1Notation(),
    rows: rng.getNumRows(),
    cols: rng.getNumColumns(),
    values: rng.getValues()
  };
}

/**
 * write { tab, startCell, values }
 * values is a 2D array. The target range is derived from its dimensions,
 * so you never have to hand-compute an A1 range that matches.
 *   e.g. { tab:'Itinerary', startCell:'B14', values:[['9.00am','Breakfast']] }
 */
function opWrite(ss, req) {
  var sheet = mustGetTab(ss, req.tab);
  var values = mustGetGrid(req.values);

  if (!req.startCell) throw new Error('write requires startCell (e.g. "A5")');

  var anchor = sheet.getRange(req.startCell);
  var target = sheet.getRange(
    anchor.getRow(),
    anchor.getColumn(),
    values.length,
    values[0].length
  );

  var before = target.getValues();
  target.setValues(values);
  SpreadsheetApp.flush();

  writeLog(ss, 'write', sheet.getName(), target.getA1Notation(), values.length * values[0].length);

  return {
    ok: true,
    tab: sheet.getName(),
    updatedRange: target.getA1Notation(),
    cellsWritten: values.length * values[0].length,
    previousValues: before   // returned so a mistaken write can be reversed
  };
}

/**
 * append { tab, values }
 * Adds rows below the last populated row. Safer than write for adding
 * itinerary items, since it cannot overwrite anything.
 */
function opAppend(ss, req) {
  var sheet = mustGetTab(ss, req.tab);
  var values = mustGetGrid(req.values);

  var startRow = sheet.getLastRow() + 1;
  var target = sheet.getRange(startRow, 1, values.length, values[0].length);
  target.setValues(values);
  SpreadsheetApp.flush();

  writeLog(ss, 'append', sheet.getName(), target.getA1Notation(), values.length * values[0].length);

  return {
    ok: true,
    tab: sheet.getName(),
    appendedRange: target.getA1Notation(),
    rowsAppended: values.length
  };
}

// ---------------------------------------------------------------- helpers

function mustGetTab(ss, name) {
  if (!name) throw new Error('missing "tab"');
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error(
      'no tab named "' + name + '". Available: ' +
      ss.getSheets().map(function (s) { return s.getName(); }).join(', ')
    );
  }
  return sheet;
}

function mustGetGrid(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('"values" must be a non-empty 2D array');
  }
  if (!Array.isArray(values[0])) {
    throw new Error('"values" must be 2D, e.g. [["a","b"]] not ["a","b"]');
  }

  var width = values[0].length;
  for (var i = 0; i < values.length; i++) {
    if (!Array.isArray(values[i]) || values[i].length !== width) {
      throw new Error('every row in "values" must have the same length (' + width + ')');
    }
  }

  var cells = values.length * width;
  if (cells > MAX_CELLS) {
    throw new Error('refusing to write ' + cells + ' cells; limit is ' + MAX_CELLS);
  }
  return values;
}

function writeLog(ss, op, tab, range, cells) {
  if (!LOG_TAB) return;
  try {
    var log = ss.getSheetByName(LOG_TAB) || ss.insertSheet(LOG_TAB);
    log.appendRow([new Date(), op, tab, range, cells]);
  } catch (ignored) {}
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
