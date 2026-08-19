---
name: google-sheets-editor
description: >-
  Read and edit Google Sheets cell-by-cell through a deployed Apps Script
  bridge — reading tabs and ranges, writing values into specific cells,
  appending rows, and creating tabs. Reach for this whenever the user wants
  something changed inside a Google Sheet, or wants sheet contents read back
  as structured rows: filling in a cell, adding a row, updating a column,
  ticking off a checklist item, building out a new tab, or auditing and
  cross-checking what a sheet actually contains. The plain Google Drive
  connector cannot do any of this — its update_file only renames files and
  moves them between folders, with no cell-level write — so use this skill
  rather than telling the user the edit is impossible or falling back on
  driving a browser. Note the bridge reaches only the specific spreadsheets
  its deployment exposes; run ping first to see which.
---

# Google Sheets Editor

Cell-level read/write access to Google Sheets via a small Apps Script web app,
which runs on Google's servers and therefore works unattended — no browser, no
laptop needing to stay awake.

The server side of this skill lives in `Code.gs` one directory up. If the
bridge has not been deployed yet, or `bridge.py` still contains placeholder
values, see that directory's `README.md` — the skill cannot work until the
deployment exists.

## Scope: which spreadsheets this can reach

The bridge is **not** a general Google Sheets client. The Apps Script
deployment holds a fixed allowlist mapping short keys to spreadsheet IDs, and
every request names one of those keys via `book`.

Discover the keys rather than assuming them — send a `ping` and read the
response. If you pass an unknown key the error itself lists what's valid:

```json
{"ok": false, "error": "unknown book: foo", "allowed": ["..."]}
```

Two things follow from this that will otherwise cost you time:

- **A raw spreadsheet ID in `book` does not work.** It's treated as an
  unknown key and rejected. Only the short keys resolve.
- **Unrecognised parameters are ignored silently, not rejected.** Passing
  something like `spreadsheetId` doesn't error — the request succeeds against
  the *default* spreadsheet (the first key in the allowlist), so you get a
  confident-looking result for the wrong file. If a response's `title` or
  `url` isn't what you expected, this is why. Check them rather than trusting
  that the call "worked."

### Adding a spreadsheet to the allowlist

The gating is deliberate, not a defect — it's what stops this bridge from
being a general write key to someone's entire Drive. So when a user asks about
a spreadsheet that isn't on the list, the answer isn't a workaround. It's a
short piece of setup that only the deployment owner can do:

1. Open the Apps Script project, go to Project Settings → Script Properties,
   and add an entry to the `ALLOWED` JSON object, pairing a new short key with
   the target spreadsheet's ID (the long string between `/d/` and `/edit` in
   its URL).
2. Confirm the spreadsheet is reachable by the account the script runs as. A
   sheet owned by someone else needs to be shared with that account first —
   otherwise the key resolves but every operation fails on permissions.
3. Script Properties are read per request, so an allowlist change takes effect
   immediately with no redeploy. **Editing `Code.gs` is different** — the
   `/exec` URL serves the deployed version, so a code edit that hasn't been
   redeployed is invisible to this bridge. Deploying as a *new version of the
   existing deployment* keeps the same `/exec` URL and token, so `bridge.py`
   needs no change. Creating a brand-new deployment issues a different URL,
   which would mean updating the script.

Then `ping` the new key to confirm it resolves to the spreadsheet expected.

You can walk a user through this, but you can't do it for them — the Apps
Script project isn't reachable from here. Say that plainly rather than
implying the sheet might work if you just try it.

## How to call it

Use the bundled script. It handles a redirect quirk that will otherwise waste
your time (see below).

```bash
python3 scripts/bridge.py '{"op":"ping","book":"<key>"}'
```

### Operations

| op | Arguments | Returns |
|---|---|---|
| `ping` | — | Spreadsheet title, URL, tab names, row/column counts. Do this first to orient. |
| `read` | `tab`, optional `range` | 2D array of values. Omit `range` for the whole used area. |
| `write` | `tab`, `startCell`, `values` | Writes a 2D array anchored at `startCell`. Returns `previousValues`. |
| `append` | `tab`, `values` | Adds rows below the last populated row. |
| `addTab` | `tab`, optional `headers`, `index`, `copyFrom` | Creates a new tab. Refuses if the name is taken. |

Examples:

```bash
python3 scripts/bridge.py '{"op":"read","book":"<key>","tab":"Sheet1"}'

python3 scripts/bridge.py '{"op":"read","book":"<key>","tab":"Sheet1",
  "range":"A1:D20"}'

python3 scripts/bridge.py '{"op":"append","book":"<key>","tab":"Log",
  "values":[["2026-08-19","entry text"]]}'

python3 scripts/bridge.py '{"op":"write","book":"<key>","tab":"Sheet1",
  "startCell":"B14","values":[["value one","value two","value three"]]}'

python3 scripts/bridge.py '{"op":"addTab","book":"<key>","tab":"Draft",
  "headers":["Column A","Column B","Column C"]}'
```

### Prefer `append` over `write` when adding

`append` cannot overwrite anything — it always lands below the last populated
row. `write` can clobber. When the goal is "add something," reach for
`append`; save `write` for genuinely replacing a known cell.

When you do use `write`, it returns `previousValues` containing exactly what
was overwritten. Surface that in your reply so a mistake can be undone without
digging through version history.

A single call is capped at 5,000 cells server-side. A larger write is refused
outright rather than partially applied — split it into batches.

### `addTab` notes

Creating a tab is additive and cannot overwrite — it errors if the name
already exists. It's still a change to someone's spreadsheet, so the approval
rule below applies.

A new tab with no headers reports `0, 0` in `ping`, because `ping` counts
populated cells rather than allocated grid. That is not a failed creation —
check the `tabs` list in the response instead.

`copyFrom` clones the source tab's data as well as its formatting.

### The redirect quirk (already handled, don't re-derive it)

A POST to the `/exec` URL returns a 302 to
`script.googleusercontent.com/macros/echo?...`. Following that redirect while
carrying the POST method or `Content-Type` returns **405 Method Not Allowed** —
both plain `curl -L` and `curl -L --post302` fail this way, and it looks like a
broken deployment when it isn't.

The correct pattern is two explicit steps: POST without following redirects,
capture the `Location` header, then issue a clean GET on it. `bridge.py` does
this. If you find yourself debugging a 405, you have probably reimplemented the
call by hand — use the script instead.

A plain GET on `/exec` returns a health check, which is the quickest way to
confirm the deployment is alive.

### If it fails with a network error

The container's egress allowlist must include both `script.google.com` and
`script.googleusercontent.com`. If a call returns "Host not in allowlist," tell
the user — it's a settings change on their side, not something to work around.
Do not attempt to bypass it.

If instead the response is `{"ok": false, "error": "bad or missing token"}`,
the `TOKEN` in `bridge.py` no longer matches the `TOKEN` script property. That
is also the owner's to fix.

## Working rules

**Never edit without approval.** Reading is always fine. For any write, say
what you intend to put where, and wait. A direct instruction ("add a row to the
Log tab with today's date") *is* approval — you don't need to ask twice. An
inference ("it'd be better if this column had units") is not.

**Verify writes independently.** After writing, read the range back and show
the result. A write that reports success is not the same as a write that landed
correctly, and the silent-parameter behaviour above means a plausible success
response can still describe the wrong file.

**Don't guess at structure.** Tab names, column order and merged-cell layout
routinely differ from what a flattened text dump of a spreadsheet implies.
Merged cells in particular break row alignment, so read a tab before reasoning
about where a value belongs. Run `ping`, then `read`, then act.

**Say what you can't do.** If something genuinely isn't possible — a
spreadsheet outside the allowlist, an operation the bridge doesn't expose — say
so plainly rather than producing a workaround that looks like the real thing.
