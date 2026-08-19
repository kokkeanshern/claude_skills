# Sheets Bridge

A minimal JSON endpoint that lets Claude read and write Google Sheets **cell by
cell** — including editing cells in place, which the built-in Google Drive
connector cannot do. Its `update_file` only renames files and moves them
between folders.

The endpoint is a Google Apps Script web app, so it runs on Google's servers.
No browser session, no machine that has to stay awake, and it works equally
well from a scheduled task as from a live chat.

## What's here

```
sheets_bridge/
├── Code.gs                       server — paste into an Apps Script project
├── README.md                     this file
└── google-sheets-editor/         client — zip this into a Claude skill
    ├── SKILL.md
    └── scripts/
        └── bridge.py
```

The two halves are independent: `Code.gs` is deployed once and lives in your
Google account; the skill folder is packaged and uploaded to Claude, and just
holds the URL and token needed to reach it.

## Setup

### 1. Deploy the Apps Script

1. Go to [script.google.com](https://script.google.com) → **New project**, and
   replace the contents of `Code.gs` with this repo's `Code.gs`.
2. **Project Settings** (gear icon) → **Script Properties** → add two:

   | Property | Value |
   |---|---|
   | `TOKEN` | A long random string — `uuidgen`, or any 32+ random characters. |
   | `ALLOWED` | A JSON object mapping short keys to spreadsheet IDs, e.g. `{"main":"1AbC...","scratch":"1XyZ..."}` |

   A spreadsheet ID is the long segment of its URL between `/d/` and `/edit`.

3. **Deploy** → **New deployment** → type **Web app**, with:
   - Execute as: **Me**
   - Who has access: **Anyone**

   "Anyone" is required for a server to reach the endpoint at all. `TOKEN` is
   what actually protects it — which is why it must not be guessable.

4. Authorise when prompted, then copy the `/exec` URL.

5. Sanity check — a plain GET returns a health response:

   ```bash
   curl -sL "<your /exec URL>"
   # {"ok":true,"service":"sheets-bridge","note":"Alive. POST a JSON body with a valid token to use."}
   ```

### 2. Package the skill

```bash
# fill in URL and TOKEN at the top of google-sheets-editor/scripts/bridge.py first
cd sheets_bridge
zip -r google-sheets-editor.zip google-sheets-editor
```

Upload the zip in Claude under **Settings → Capabilities → Skills**. Then ask
Claude to ping the bridge; it should come back with your spreadsheet's title
and tab list.

Don't commit a filled-in `bridge.py`. Either keep the zip local, or add
`google-sheets-editor.zip` and your working copy to `.gitignore`.

### 3. Allow the egress hosts

If Claude runs with a network allowlist, it needs both `script.google.com` and
`script.googleusercontent.com` — the POST lands on the first and is redirected
to the second. Missing the second host produces a network error partway
through an otherwise correct call.

## API

Every request is a POST of a JSON body containing `token`, `op`, and — unless
you want the first allowlist entry — `book`.

| op | Arguments | Returns |
|---|---|---|
| `ping` | — | Title, URL, and each tab's name, row count, column count. |
| `read` | `tab`, optional `range` | 2D array of values. Omit `range` for the whole used area. |
| `write` | `tab`, `startCell`, `values` | Writes a 2D array anchored at `startCell`; returns `previousValues`. |
| `append` | `tab`, `values` | Adds rows below the last populated row. |
| `addTab` | `tab`, optional `headers`, `index`, `copyFrom` | Creates a tab; errors if the name exists. |

```bash
python3 scripts/bridge.py '{"op":"ping","book":"main"}'
python3 scripts/bridge.py '{"op":"read","book":"main","tab":"Sheet1","range":"A1:D20"}'
python3 scripts/bridge.py '{"op":"append","book":"main","tab":"Log","values":[["2026-08-19","entry"]]}'
```

The target range for `write` is derived from the dimensions of `values`, so
there's no hand-computed A1 range to get wrong. `values` must be 2D —
`[["a","b"]]`, not `["a","b"]` — and every row must be the same length.

### Design choices worth knowing

- **`append` cannot overwrite.** It always lands below the last populated row.
  Prefer it over `write` whenever the goal is to add rather than replace.
- **`write` returns `previousValues`.** Whatever it clobbered comes back in the
  response, so a mistake is reversible without version history.
- **`addTab` refuses an existing name** rather than clobbering or renaming —
  same spirit as `append` vs `write`.
- **Writes are capped at `MAX_CELLS`** (5,000 by default, at the top of
  `Code.gs`) to bound a runaway call. Over the limit is refused outright, not
  partially applied.
- **Optional write log.** Set `LOG_TAB` in `Code.gs` to a tab name such as
  `'_log'` and every write, append, and addTab appends a timestamped row there.
  Off by default.

### The redirect quirk

A POST to `/exec` returns a 302 to `script.googleusercontent.com/macros/echo`.
Following it while still carrying the POST method or `Content-Type` returns
**405 Method Not Allowed** — both `curl -L` and `curl -L --post302` fail this
way, which looks like a broken deployment but isn't.

The working pattern is two explicit steps: POST without following redirects,
capture the `Location` header, then a clean GET on it. `bridge.py` already does
this; reach for it rather than reimplementing the call.

## After editing Code.gs

**Deploy → Manage deployments → edit → Version: New version.** Saving the file
alone does not change what the `/exec` URL serves, so an un-redeployed edit is
invisible.

Deploying a new version of the *existing* deployment keeps the same URL and
token, so the skill needs no change. Creating a *new* deployment issues a
different URL, which means editing `bridge.py` and re-zipping.

Script Properties are the exception — they're read per request, so adding a
spreadsheet to `ALLOWED` or rotating `TOKEN` takes effect immediately.

## Security notes

- The endpoint can only touch spreadsheets listed in `ALLOWED`. It is not a
  general key to your Drive. Keeping that list short is the main control.
- `Code.gs` contains no secrets and is safe to commit as-is. All configuration
  lives in Script Properties.
- The token is the only thing standing between the open web and those
  spreadsheets, since access is set to "Anyone". Treat it accordingly: don't
  paste it into a chat message or commit it.
- Rotate by changing the `TOKEN` property and updating `bridge.py`. No redeploy
  needed.
- Revoke entirely: **Deploy → Manage deployments → Archive.**
