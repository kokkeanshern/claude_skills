/**
 * Sheets Bridge
 * A minimal JSON endpoint so an agent can read and write Google Sheets
 * without a browser session or a machine being awake.
 *
 * This file contains no secrets and is safe to commit as-is. All config
 * lives in Script Properties.
 *
 * SETUP
 *   1. script.google.com -> New project, paste this file in
 *   2. Project Settings (gear) -> Script Properties -> add two properties:
 *
 *        TOKEN     a long random string, e.g. from `uuidgen`
 *        ALLOWED   a JSON object mapping short keys to spreadsheet IDs:
 *                  {"main":"1AbC...","scratch":"1XyZ..."}
 *
 *      The ID is the long segment in a sheet URL between /d/ and /edit.
 *
 *   3. Deploy -> New deployment -> type: Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      ("Anyone" is required for a server to reach it. TOKEN is what
 *       actually protects it - that is why it must not be guessable.)
 *   4. Authorise when prompted, then copy the /exec URL
 *
 * AFTER ANY CODE EDIT
 *   Deploy -> Manage deployments -> edit -> Version: New version.
 *   Saving alone does not change what the /exec URL serves.
 *
 * SECURITY NOTES
 *   - This endpoint can ONLY touch the spreadsheets listed in ALLOWED.
 *     It is not a general key to your Drive.
 *   - Reads are unrestricted; writes are capped at MAX_CELLS per call.
 *   - Revoke at any time: Deploy -> Manage deployments -> Archive.
 *   - Rotate by changing the TOKEN property. No redeploy needed - script
 *     properties are read per request, not baked into the version.
 */

// ---------------------------------------------------------------- config

const MAX_CELLS = 5000;   // guard against a runaway write
const LOG_TAB   = null;   // set to a tab name (e.g. '_log') to record every write

/** Secrets live in Script Properties, never in this file. */
function config() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TOKEN');
  var rawAllowed = props.getProperty('ALLOWED');

  if (!token) {
    throw new Error('not configured: set the TOKEN script property');
  }
  if (!rawAllowed) {
    throw new Error('not configured: set the ALLOWED script property');
  }

  var allowed;
  try {
    allowed = JSON.parse(rawAllowed);
  } catch (err) {
    throw new Error('ALLOWED script property is not valid JSON');
  }
  if (!allowed || typeof allowed !== 'object' || Array.isArray(allowed)) {
    throw new Error('ALLOWED must be a JSON object, e.g. {"main":"1AbC..."}');
  }
  if (!Object.keys(allowed).length) {
    throw new Error('ALLOWED is empty - add at least one spreadsheet');
  }

  return { token: token, allowed: allowed };
}

// ---------------------------------------------------------------- routing

function doGet() {
  return json({
    ok: true,
    service: 'sheets-bridge',
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

    var cfg = config();

    if (!req.token || req.token !== cfg.token) {
      return json({ ok: false, error: 'bad or missing token' });
    }

    var keys = Object.keys(cfg.allowed);
    var book = req.book || keys[0];
    var id = cfg.allowed[book];
    if (!id) {
      return json({
        ok: false,
        error: 'unknown book: ' + book,
        allowed: keys
      });
    }

    var ss = SpreadsheetApp.openById(id);

    switch (req.op) {
      case 'ping':   return json(opPing(ss, book));
      case 'read':   return json(opRead(ss, req));
      case 'write':  return json(opWrite(ss, req));
      case 'append': return json(opAppend(ss, req));
      case 'addTab': return json(opAddTab(ss, req));
      default:
        return json({
          ok: false,
          error: 'unknown op: ' + req.op,
          ops: ['ping', 'read', 'write', 'append', 'addTab']
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
 *   e.g. { tab:'Sheet1', startCell:'B14', values:[['9.00am','Breakfast']] }
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
 * records, since it cannot overwrite anything.
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

/**
 * addTab { tab, headers?, index?, copyFrom? }
 * Creates a new tab. Refuses if the name is already taken, so it can never
 * clobber or rename an existing tab — same spirit as append vs write.
 *   tab       name of the new tab
 *   headers   optional 1D array written to row 1, bolded and frozen
 *   index     optional 0-based position in the tab strip; default is last
 *   copyFrom  optional existing tab to clone layout and formatting from
 *             (note: this copies the source tab's data as well)
 */
function opAddTab(ss, req) {
  var name = String(req.tab == null ? '' : req.tab).trim();

  if (!name) throw new Error('addTab requires a non-empty "tab"');
  if (name.length > 100) {
    throw new Error('tab name too long (Sheets allows 100 characters)');
  }
  if (ss.getSheetByName(name)) {
    throw new Error(
      'tab "' + name + '" already exists — nothing was created. Existing: ' +
      ss.getSheets().map(function (s) { return s.getName(); }).join(', ')
    );
  }

  // Position: clamp into range, default to the end of the tab strip.
  var total = ss.getNumSheets();
  var pos = total;
  if (req.index !== undefined && req.index !== null && req.index !== '') {
    var wanted = Number(req.index);
    if (isNaN(wanted)) throw new Error('"index" must be a number');
    pos = Math.min(Math.max(0, Math.floor(wanted)), total);
  }

  // Optional: clone an existing tab's layout and formatting.
  var template = null;
  if (req.copyFrom) {
    template = mustGetTab(ss, req.copyFrom);
  }

  var sheet = template
    ? ss.insertSheet(name, pos, { template: template })
    : ss.insertSheet(name, pos);

  // Optional header row.
  var headers = null;
  if (req.headers !== undefined && req.headers !== null) {
    if (!Array.isArray(req.headers) || Array.isArray(req.headers[0])) {
      throw new Error('"headers" must be a 1D array, e.g. ["Day","Time"]');
    }
    if (req.headers.length) {
      headers = req.headers.map(function (h) { return h == null ? '' : h; });
      var row = sheet.getRange(1, 1, 1, headers.length);
      row.setValues([headers]);
      row.setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }

  SpreadsheetApp.flush();
  writeLog(ss, 'addTab', name, headers ? 'row 1' : '', headers ? headers.length : 0);

  return {
    ok: true,
    created: name,
    index: sheet.getIndex(),        // 1-based, as shown in the tab strip
    gid: sheet.getSheetId(),
    url: ss.getUrl() + '#gid=' + sheet.getSheetId(),
    maxRows: sheet.getMaxRows(),    // allocated grid, not populated rows
    maxCols: sheet.getMaxColumns(),
    headers: headers,
    copiedFrom: req.copyFrom || null,
    tabs: ss.getSheets().map(function (s) { return s.getName(); })
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
