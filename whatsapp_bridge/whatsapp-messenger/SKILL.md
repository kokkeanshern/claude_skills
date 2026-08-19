---
name: whatsapp-messenger
description: >-
  Send WhatsApp messages to individuals and group chats from a Claude container,
  by building and pairing the whatsapp-mcp Go bridge in-session. Reach for this
  when the user asks to send a WhatsApp message, text someone, or post to one
  of their group chats. Also covers looking up a group's JID by name, since
  groups can only be addressed by JID. Setup takes a few minutes and has to be
  redone every session — the container resets, so the build and the WhatsApp
  pairing are both lost between conversations, and the user must re-pair from
  their phone each time. Requires specific domains on the container's egress
  allowlist; if they're missing the user has to add them, which only they can do.
---

# WhatsApp Messenger

Sends WhatsApp messages via [verygoodplugins/whatsapp-mcp](https://github.com/verygoodplugins/whatsapp-mcp),
a Go bridge that pairs as a linked device (same mechanism as WhatsApp Web) and
serves a local HTTP API.

## Tell the user the cost before starting

Setup is a few minutes of building plus a pairing step **they** have to do on
their phone, and none of it survives the session. If they just want one message
sent, opening WhatsApp is faster. Say so once, plainly, then do what they ask.

Don't start a build without checking they want it — a user asking "can you
WhatsApp my brother?" may not realise what they're agreeing to.

## Prerequisite: egress allowlist

The container must allow: `web.whatsapp.com`, `g.whatsapp.net`,
`mmg.whatsapp.net`, `proxy.golang.org`, `sum.golang.org`, `github.com`.

If these are missing, the bridge fails at `expected handshake response status
code 101 but got 403` — that 403 is the egress proxy, not WhatsApp. **Only the
user can fix this**, in their Claude settings, and the change applies only to
containers started afterwards, so they need a fresh conversation. Tell them
that; don't try to route around it.

## Setup

```bash
bash scripts/setup.sh
```

Installs Go from the GitHub Actions mirror (`dl.google.com` is blocked),
clones the bridge, adds the two helpers from `patches/`, and builds. Takes a
few minutes, mostly cgo compiling SQLite.

## Pairing

Pair by phone code, not QR. Ask for the number in international format, no `+`
and no leading zero (Malaysia `0123456789` → `60123456789`):

```bash
cd /home/claude/whatsapp-mcp/whatsapp-bridge && ./pairer 60123456789
```

It prints an eight-character code. Give it to the user with these steps:
WhatsApp → Settings → Linked Devices → Link a Device →
**"Link with phone number instead"** (small text link under the camera) →
enter the code. It holds the socket ~200s and exits after flushing the session.

Confirm `>>> PAIR SUCCESS` in the output before continuing.

**Why not QR:** the bridge prints one, but it rotates every 60s and the socket
periodically redials, reissuing all codes. Rendering it as an image and waiting
for the user almost always produces a stale code, which WhatsApp reports as
*"Couldn't link device — check your internet connection"* — sounds like a
network fault, isn't. Don't spend turns on this; use the pairing code.

## Sending

Start the bridge and **wait ~10 seconds** — it authenticates before the API
answers:

```bash
cd /home/claude/whatsapp-mcp/whatsapp-bridge && \
  setsid nohup ./whatsapp-bridge > /tmp/bridge.log 2>&1 < /dev/null &
sleep 12
```

Then:

```bash
export WHATSAPP_BRIDGE_DIR=/home/claude/whatsapp-mcp/whatsapp-bridge
python3 scripts/wa.py health
python3 scripts/wa.py send 60123456789 "message text"
python3 scripts/wa.py send 120363012345678901@g.us "message text"
python3 scripts/wa.py send <recipient> --file body.txt
```

**Use `wa.py`, not curl.** Apostrophes, quotes, emoji and newlines get mangled
by shell quoting — you'll send something subtly wrong, or get a failure that
looks like a bridge fault. `wa.py` builds the JSON in Python. Use `--file` for
anything long or punctuation-heavy.

**The bridge gets reaped between turns.** A backgrounded process often dies
once the turn ends, so `health` failing on a later turn is normal — restart it
and resend. Check before assuming something broke.

## Groups

Groups are addressable only by JID, and `store/messages.db` is usually empty
(history sync fails, below), so query WhatsApp directly:

```bash
python3 scripts/wa.py groups
```

**Stop the bridge first** — this opens its own connection on the same device
session and two clients conflict. Sequence: stop → list → restart → send.

Group names carry emoji, trailing spaces and odd capitalisation, so match
case-insensitively on a substring. If more than one matches, ask which —
sending to the wrong group chat can't be gracefully undone.

## Working rules

**Never send a message the user didn't approve.** This writes to other
people's phones. A direct instruction containing the wording ("tell the family
group I'm running late") is approval — send it. A vague one ("send something
funny to X") is not: draft two or three options and let them choose. The extra
round trip is worth it; delete-for-everyone has a time limit and notifications
have already fired.

**Don't invent content about third parties.** Mention people by name if asked,
but don't attribute opinions, plans or characteristics to them.

**Report any wording you changed**, including punctuation — the user may have
to explain the message to real people.

**Confirm from `success: true`**, not from the absence of an error.

## Known broken: history sync and media

App-state and history sync fail with 403 — they download from rotating
`media-*.cdn.whatsapp.net` hosts. Symptoms: no contact names, no chat history,
media send/receive failing. Text sending is unaffected; it goes over the main
WebSocket.

The fix is `*.cdn.whatsapp.net` on the allowlist — wildcards matter, the
hostnames rotate per connection. User's change to make; mention it and move on.

## Account risk

Linked-device automation is not a supported WhatsApp API and accounts have been
banned for it — on WhatsApp that costs the phone number, not just a login. Risk
rises with volume, with messaging strangers, and with anything resembling bulk
sending. If the user heads that way, say so plainly. Don't help build a blast
tool.
