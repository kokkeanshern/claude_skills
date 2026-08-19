#!/usr/bin/env python3
"""Thin client for the whatsapp-mcp Go bridge's local HTTP API.

Why this exists rather than calling curl directly: message text routinely
contains apostrophes, quotes, emoji and newlines. Building the JSON body in a
shell string mangles all of those — an apostrophe alone will break the payload
or silently truncate it. This builds the body in Python and posts it as bytes.

Usage:
    wa.py health
    wa.py groups                       # requires the bridge to be stopped
    wa.py send <recipient> <message>
    wa.py send <recipient> --file body.txt

<recipient> is either a bare phone number in international format without '+'
(e.g. 60123456789) or a full JID (e.g. 120363012345678901@g.us for a group).
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

BRIDGE_URL = os.environ.get("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:8080/api")
BRIDGE_DIR = os.environ.get("WHATSAPP_BRIDGE_DIR", ".")


def token() -> str:
    env = os.environ.get("WHATSAPP_BRIDGE_TOKEN")
    if env:
        return env
    path = os.path.join(BRIDGE_DIR, "store", ".bridge-token")
    try:
        with open(path) as fh:
            return fh.read().strip()
    except FileNotFoundError:
        sys.exit(
            f"No token. Set WHATSAPP_BRIDGE_TOKEN or run from the bridge "
            f"directory so {path} is readable.\n"
            f"The bridge prints the token on first start."
        )


def call(endpoint: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{BRIDGE_URL}/{endpoint}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        sys.exit(f"HTTP {exc.code} from bridge: {body}")
    except urllib.error.URLError as exc:
        sys.exit(
            f"Cannot reach the bridge at {BRIDGE_URL} ({exc.reason}).\n"
            f"It is probably not running. Start it, wait ~10s for it to "
            f"authenticate, then retry."
        )


def cmd_health(_args) -> None:
    req = urllib.request.Request(
        f"{BRIDGE_URL}/health", headers={"Authorization": f"Bearer {token()}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        sys.exit(f"Bridge not reachable at {BRIDGE_URL}: {exc}")


def cmd_send(args) -> None:
    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            message = fh.read().rstrip("\n")
    else:
        message = args.message
    if not message:
        sys.exit("Empty message; refusing to send.")
    result = call("send", {"recipient": args.recipient, "message": message})
    print(json.dumps(result, ensure_ascii=False))
    if not result.get("success"):
        sys.exit(1)


def cmd_groups(_args) -> None:
    """List joined groups. Runs the compiled `groups` helper, which opens its
    own WhatsApp connection — so the bridge must be stopped first (one client
    per session)."""
    binary = os.path.join(BRIDGE_DIR, "groups")
    if not os.path.exists(binary):
        sys.exit(
            f"{binary} not found. Build it first:\n"
            f"  go build -o groups ./cmd/groups"
        )
    proc = subprocess.run([binary], cwd=BRIDGE_DIR, capture_output=True, text=True)
    out = proc.stdout + proc.stderr
    for line in out.splitlines():
        if "@g.us" in line or ">>>" in line:
            print(line)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("health").set_defaults(func=cmd_health)
    sub.add_parser("groups").set_defaults(func=cmd_groups)

    send = sub.add_parser("send")
    send.add_argument("recipient")
    send.add_argument("message", nargs="?", default=None)
    send.add_argument("--file", help="read message body from a file instead")
    send.set_defaults(func=cmd_send)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
