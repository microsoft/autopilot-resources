#!/bin/sh

set -eu

VERSION="1.0.2"
INSTALL_DIR="${SCOUT_SESSIONS_INSTALL_DIR:-"$HOME/.local/bin"}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_SCRIPT="$SCRIPT_DIR/scout-sessions.mjs"
SOURCE_LAUNCHER="$SCRIPT_DIR/scout-sessions"
if [ ! -f "$SOURCE_LAUNCHER" ]; then
  SOURCE_LAUNCHER="$SCRIPT_DIR/scout-sessions-macos"
fi
TARGET_SCRIPT="$INSTALL_DIR/scout-sessions.mjs"
TARGET_LAUNCHER="$INSTALL_DIR/scout-sessions"

usage() {
  cat <<'EOF'
Install Scout Sessions CLI for the current macOS user.

Usage:
  ./install.sh
  ./install.sh --uninstall

Set SCOUT_SESSIONS_INSTALL_DIR to override ~/.local/bin for testing or a
different user-local installation directory.
EOF
}

case "${1:-}" in
  "")
    ;;
  --uninstall)
    rm -f "$TARGET_SCRIPT" "$TARGET_LAUNCHER"
    printf 'Removed Scout Sessions CLI from %s\n' "$INSTALL_DIR"
    exit 0
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 20 or newer is required. Install Node.js, then rerun this installer.\n' >&2
  exit 1
fi

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf 'Node.js 20 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi

if [ ! -f "$SOURCE_SCRIPT" ] || [ ! -f "$SOURCE_LAUNCHER" ]; then
  printf 'Missing adjacent scout-sessions.mjs or scout-sessions launcher. Keep the extracted bundle together.\n' >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
umask 077
TEMP_DIR=$(mktemp -d "$INSTALL_DIR/.scout-sessions.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
cp "$SOURCE_SCRIPT" "$TEMP_DIR/scout-sessions.mjs"
cp "$SOURCE_LAUNCHER" "$TEMP_DIR/scout-sessions"
chmod 0755 "$TEMP_DIR/scout-sessions.mjs" "$TEMP_DIR/scout-sessions"
node "$TEMP_DIR/scout-sessions.mjs" --help >/dev/null
mv -f "$TEMP_DIR/scout-sessions.mjs" "$TARGET_SCRIPT"
mv -f "$TEMP_DIR/scout-sessions" "$TARGET_LAUNCHER"
rmdir "$TEMP_DIR"
trap - EXIT HUP INT TERM

printf 'Installed Scout Sessions CLI v%s at %s\n' "$VERSION" "$TARGET_LAUNCHER"
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    printf 'Run: scout-sessions --help\n'
    ;;
  *)
    printf 'Add this directory to PATH, then open a new Terminal:\n  %s\n' "$INSTALL_DIR"
    printf 'For zsh, add this line to ~/.zshrc:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac
