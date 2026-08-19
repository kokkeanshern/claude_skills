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
    wa.py messages [--chat JID] [--limit N] [--since '2026-08-19 15:00']
    wa.py media <message_id> [--out path.jpg]

<recipient> is either a bare phone number in international format without '+'
(e.g. 60123456789) or a full JID (e.g. 120363012345678901@g.us for a group).

`messages` and `media` read store/messages.db directly rather than going
through the bridge's HTTP API. The bridge only writes to that database while
it is running, so anything that arrived while it was down is simply absent —
a quiet gap, not an error. `media` also bypasses the bridge's /api/download,
which routes through rotating media-*.cdn.whatsapp.net hosts that a
restricted egress allowlist will refuse; see cmd_media for the detail.
"""

import argparse
import hashlib
import hmac
import json
import os
import sqlite3
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


def _message_db() -> sqlite3.Connection:
    path = os.path.join(BRIDGE_DIR, "store", "messages.db")
    if not os.path.exists(path):
        sys.exit(
            f"{path} not found. The bridge creates it on first run; if you "
            f"have only paired, no messages have been captured yet."
        )
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def cmd_messages(args) -> None:
    """Print stored messages, newest first, as JSON lines."""
    where, params = [], []
    if args.chat:
        jid = args.chat if "@" in args.chat else f"{args.chat}@s.whatsapp.net"
        where.append("chat_jid = ?")
        params.append(jid)
    if args.since:
        where.append("timestamp >= ?")
        params.append(args.since)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    params.append(args.limit)

    conn = _message_db()
    rows = conn.execute(
        f"SELECT id, chat_jid, sender, timestamp, is_from_me, media_type, content "
        f"FROM messages {clause} ORDER BY timestamp DESC LIMIT ?",
        params,
    ).fetchall()
    for mid, chat, sender, ts, mine, mtype, content in rows:
        print(json.dumps({
            "id": mid,
            "chat": chat,
            "sender": sender,
            "timestamp": ts,
            "from_me": bool(mine),
            "media_type": mtype or None,
            "content": content,
        }, ensure_ascii=False))
    if not rows:
        print("(no messages matched)", file=sys.stderr)


# HKDF info strings, per media type, as defined by the WhatsApp protocol.
_MEDIA_INFO = {
    "image": b"WhatsApp Image Keys",
    "video": b"WhatsApp Video Keys",
    "audio": b"WhatsApp Audio Keys",
    "document": b"WhatsApp Document Keys",
}


def _hkdf(key: bytes, info: bytes, length: int = 112) -> bytes:
    """HKDF-SHA256 with a zero salt — the expansion WhatsApp uses for media."""
    prk = hmac.new(b"\x00" * 32, key, hashlib.sha256).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def cmd_media(args) -> None:
    """Download and decrypt one media message.

    Deliberately does NOT use the bridge's /api/download. That path asks
    WhatsApp for a media connection and is handed a rotating
    media-<region>.cdn.whatsapp.net host; a restricted egress allowlist
    rejects those (403, x-deny-reason: host_not_allowed) and there is no
    stable hostname to allowlist. The URL stored with the message points at
    mmg.whatsapp.net, which is a single stable host, so fetch that and do the
    decryption here. Media is AES-256-CBC; the key, IV and MAC key are
    derived from the message's media_key, and the last 10 bytes of the blob
    are an HMAC-SHA256 truncation over IV + ciphertext.

    The URL carries an `oe=` expiry, so old messages will eventually 404.
    """
    conn = _message_db()
    row = conn.execute(
        "SELECT url, media_key, media_type, filename FROM messages WHERE id = ?",
        (args.message_id,),
    ).fetchone()
    if row is None:
        sys.exit(f"No message with id {args.message_id} in the local database.")
    url, media_key, media_type, filename = row
    if not url or not media_key:
        sys.exit(
            f"Message {args.message_id} has no media attached "
            f"(media_type={media_type or 'none'})."
        )
    info = _MEDIA_INFO.get(media_type)
    if info is None:
        sys.exit(f"Unsupported media type {media_type!r}.")

    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, headers={"User-Agent": "WhatsApp/2.24"}),
            timeout=60,
        ) as resp:
            blob = resp.read()
    except urllib.error.HTTPError as exc:
        sys.exit(
            f"HTTP {exc.code} fetching media. If 404, the URL's `oe=` expiry "
            f"has passed and the message must be re-sent to get a fresh one."
        )
    except urllib.error.URLError as exc:
        sys.exit(f"Cannot fetch media ({exc.reason}). Is mmg.whatsapp.net allowlisted?")

    expanded = _hkdf(media_key, info)
    iv, cipher_key, mac_key = expanded[:16], expanded[16:48], expanded[48:80]
    ciphertext, mac = blob[:-10], blob[-10:]
    if hmac.new(mac_key, iv + ciphertext, hashlib.sha256).digest()[:10] != mac:
        sys.exit("MAC check failed — the download is corrupt or truncated.")

    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError:
        sys.exit("Needs the `cryptography` package: pip install cryptography")
    decryptor = Cipher(algorithms.AES(cipher_key), modes.CBC(iv)).decryptor()
    plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    plaintext = plaintext[: -plaintext[-1]]  # strip PKCS#7 padding

    out = args.out or os.path.join("/tmp", filename or f"{args.message_id}.bin")
    with open(out, "wb") as fh:
        fh.write(plaintext)
    print(json.dumps({"success": True, "path": out, "bytes": len(plaintext)}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("health").set_defaults(func=cmd_health)
    sub.add_parser("groups").set_defaults(func=cmd_groups)

    msgs = sub.add_parser("messages")
    msgs.add_argument("--chat", help="phone number or full JID to filter by")
    msgs.add_argument("--limit", type=int, default=20)
    msgs.add_argument("--since", help="timestamp lower bound, e.g. '2026-08-19 15:00'")
    msgs.set_defaults(func=cmd_messages)

    media = sub.add_parser("media")
    media.add_argument("message_id")
    media.add_argument("--out", help="output path (default /tmp/<filename>)")
    media.set_defaults(func=cmd_media)

    send = sub.add_parser("send")
    send.add_argument("recipient")
    send.add_argument("message", nargs="?", default=None)
    send.add_argument("--file", help="read message body from a file instead")
    send.set_defaults(func=cmd_send)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
