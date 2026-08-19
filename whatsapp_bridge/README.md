# whatsapp_bridge

A Claude skill that sends WhatsApp messages from a Claude container, using
[verygoodplugins/whatsapp-mcp](https://github.com/verygoodplugins/whatsapp-mcp).

Claude builds and pairs the bridge in-session. You don't install anything
locally — the only thing you do by hand is add some domains to your container's
egress allowlist, and enter a pairing code on your phone.

## Read this first

**Setup repeats every session.** The container filesystem resets, so the build
and the WhatsApp pairing are both lost when the conversation ends. Each new
conversation means a few minutes of building plus re-entering a pairing code
from your phone. That's inherent to running it here, not a bug — if you want
something that stays paired, this isn't the right home for it.

**This pairs your real WhatsApp account as a linked device.** Same mechanism as
WhatsApp Web, but driven by an unofficial client. WhatsApp doesn't support it,
and accounts have been banned for automation — which on WhatsApp costs you the
phone number, not just a login. The risk scales with volume and with messaging
people who didn't ask to hear from you.

**The bridge can read your messages, not just send them.** While it's paired it
has full account access. It only lives as long as the session, but it's worth
knowing what you're granting.

## Layout

```
whatsapp_bridge/
├── README.md                       ← you are here
└── whatsapp-messenger/             ← the skill; install this directory
    ├── SKILL.md
    ├── patches/                    ← Go helpers, built by setup.sh
    │   ├── pairer/main.go
    │   └── groups/main.go
    └── scripts/
        ├── setup.sh                ← builds everything
        └── wa.py                   ← health / send / groups
```

## Setup

### 1. Egress allowlist

Add these to your container's outbound domain allowlist in Claude settings:

```
web.whatsapp.com
g.whatsapp.net
mmg.whatsapp.net
proxy.golang.org
sum.golang.org
github.com
```

Optionally `*.cdn.whatsapp.net` too — without it, chat history and contact
names don't sync and media won't send. Plain text messaging works either way.

**Allowlist changes only affect containers created afterwards**, so start a new
conversation once you've saved them. If you skip this, the bridge fails with
`expected handshake response status code 101 but got 403` — that 403 comes from
the egress proxy, not from WhatsApp.

### 2. Install the skill

Copy `whatsapp-messenger/` into wherever your Claude skills live.

### 3. Use it

Ask Claude to send a WhatsApp message. It runs `scripts/setup.sh`, then gives
you an eight-character pairing code. On your phone:

**WhatsApp → Settings → Linked Devices → Link a Device →
"Link with phone number instead"** (a small text link under the camera view) →
enter the code.

You'll need to give Claude your number in international format — no `+`, no
leading zero. Malaysian `0123456789` becomes `60123456789`.

## What it can and can't do

| | |
|---|---|
| Send text to a contact | yes |
| Send text to a group | yes, resolved by group name |
| List your groups | yes |
| Read chat history | no — history sync fails behind the allowlist |
| Send or receive media | no — same reason |
| Survive the session | no |

## Troubleshooting

**`101 but got 403`** — allowlist missing the WhatsApp domains, or the
container predates the change. New conversation.

**QR code won't scan / "check your internet connection"** — the code expired.
The bridge rotates QR codes every 60s and reissues them on reconnect, so a code
posted into chat is usually stale by the time you scan it. Use the pairing code
route instead; that's what `pairer` exists for.

**Claude says the bridge isn't reachable mid-conversation** — backgrounded
processes get reaped between turns. It just needs restarting.

**403 errors about app state or history sync** — expected without
`*.cdn.whatsapp.net`. Doesn't affect sending text.

## Credits

Bridge by [verygoodplugins/whatsapp-mcp](https://github.com/verygoodplugins/whatsapp-mcp),
built on [whatsmeow](https://github.com/tulir/whatsmeow). The `pairer` and
`groups` helpers here are additions to that project, not modifications — they
drop into `cmd/` and use its existing dependencies.
