#!/usr/bin/env python3
"""Call the Google Sheets Apps Script bridge.

Apps Script POSTs return a 302 to script.googleusercontent.com/macros/echo.
Following that redirect while carrying the POST method/headers yields a 405,
so we do it in two explicit steps: POST to capture Location, then a clean GET.

Usage:  python3 bridge.py '<json payload without token>'

BEFORE USE
  Fill in URL and TOKEN below, then zip this skill folder and upload it.
  Both values come from the Apps Script deployment described in the
  sheets_bridge README one directory up:

    URL    the /exec URL from Deploy -> Manage deployments
    TOKEN  the TOKEN script property value

  Edit them in this file rather than pasting them into a chat message. A
  bundled file is read only when the skill loads; a chat message persists in
  the transcript forever. For the same reason, keep a filled-in copy of this
  file out of version control.
"""

import json
import sys
import urllib.request
import urllib.error

URL = "PASTE_YOUR_EXEC_URL_HERE"

TOKEN = "PASTE_YOUR_TOKEN_HERE"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, newurl, headers, fp)


def call(payload):
    if URL.startswith("PASTE_") or TOKEN.startswith("PASTE_"):
        raise SystemExit(
            "bridge.py is not configured: set URL and TOKEN at the top of this "
            "file to the values from your Apps Script deployment."
        )

    body = dict(payload)
    body["token"] = TOKEN
    data = json.dumps(body).encode()

    req = urllib.request.Request(
        URL, data=data, headers={"Content-Type": "application/json"}
    )
    opener = urllib.request.build_opener(NoRedirect)

    try:
        resp = opener.open(req, timeout=60)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307):
            raise
        echo_url = e.reason  # NoRedirect stashes newurl here
        with urllib.request.urlopen(echo_url, timeout=60) as r:
            return json.loads(r.read())


if __name__ == "__main__":
    print(json.dumps(call(json.loads(sys.argv[1])), indent=2, ensure_ascii=False))
