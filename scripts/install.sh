#!/bin/sh
# Copy the PR List mod into a Herdr home. Refuses to overwrite an existing mods/pr-list
# unless --force is given. It doesn't touch any layout: add the two blocks from the
# README to yours afterwards.
#   ./scripts/install.sh            stop if mods/pr-list is already there
#   ./scripts/install.sh --force    replace it
# HERDR_APP_HOME picks another Herdr home (default ~/.config/herdr-app).
set -eu
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FORCE="${1:-}"

case "$FORCE" in ""|--force) ;; *) echo "Usage: $0 [--force]" >&2; exit 2 ;; esac
[ -d "$HOME_DIR" ] || { echo "No Herdr home at $HOME_DIR. Open the Herdr app once first." >&2; exit 1; }
if [ "$FORCE" != "--force" ] && [ -e "$HOME_DIR/mods/pr-list" ]; then
  echo "$HOME_DIR/mods/pr-list exists. Re-run with --force to replace it." >&2; exit 1
fi
mkdir -p "$HOME_DIR/mods/pr-list"
for f in main.js mod.json pr.svg refresh.svg; do cp "$REPO/mods/pr-list/$f" "$HOME_DIR/mods/pr-list/"; done
if command -v herdr-app >/dev/null; then
  out=$(herdr-app check "$HOME_DIR/mods/pr-list" 2>&1) || { echo "check failed: pr-list" >&2; echo "$out" >&2; }
fi
echo "Installed PR List $(cat "$REPO/VERSION" 2>/dev/null) in $HOME_DIR/mods/pr-list."
echo "Next: add its panel block and its button block to your layout (see the README)."
