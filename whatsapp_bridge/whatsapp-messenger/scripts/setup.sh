#!/usr/bin/env bash
# Build the whatsapp-mcp bridge inside a Claude container.
#
# Must be re-run every session — the container filesystem resets, taking the
# build and the WhatsApp pairing with it.
#
# Usage:  bash scripts/setup.sh
# Then:   python3 scripts/wa.py pair <number>   (see SKILL.md)

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WHATSAPP_WORK_DIR:-/home/claude}"
BRIDGE="$WORK/whatsapp-mcp/whatsapp-bridge"
GO_TARBALL="https://github.com/actions/go-versions/releases/download/1.25.13-31764271102/go-1.25.13-linux-x64.tar.gz"

echo "==> Installing Go"
# dl.google.com is not on the container allowlist; the GitHub Actions Go
# mirror is reachable because github.com and its release CDN are.
if [ ! -x "$WORK/sdk/bin/go" ]; then
  mkdir -p "$WORK/sdk"
  curl -sSL -o /tmp/go.tar.gz "$GO_TARBALL"
  tar -C "$WORK/sdk" -xzf /tmp/go.tar.gz
fi
export GOROOT="$WORK/sdk"
export PATH="$GOROOT/bin:$PATH"
export GOPATH="$WORK/go"
go version

echo "==> Cloning bridge"
if [ ! -d "$WORK/whatsapp-mcp" ]; then
  git clone --depth 1 https://github.com/verygoodplugins/whatsapp-mcp.git \
    "$WORK/whatsapp-mcp"
fi

echo "==> Adding helpers (not in upstream)"
mkdir -p "$BRIDGE/cmd/pairer" "$BRIDGE/cmd/groups"

# pairer/bridge open store/whatsapp.db without creating the directory first,
# so a fresh clone panics on "unable to open database file".
mkdir -p "$BRIDGE/store"
cp "$SKILL_DIR/patches/pairer/main.go" "$BRIDGE/cmd/pairer/main.go"
cp "$SKILL_DIR/patches/groups/main.go" "$BRIDGE/cmd/groups/main.go"

echo "==> Building (a few minutes; cgo compiles SQLite)"
cd "$BRIDGE"
go mod download
go build -o whatsapp-bridge .
go build -o pairer ./cmd/pairer
go build -o groups ./cmd/groups

echo
echo "==> Done. Bridge dir: $BRIDGE"
echo "    Next: pair with  ./pairer <number-in-international-format>"
