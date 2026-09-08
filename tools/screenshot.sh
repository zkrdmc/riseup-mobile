#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Capture one screenshot from the connected Android device.
#
#   ./tools/screenshot.sh 01-sign-in
#
# Writes to riseup/assets/product-screenshots/mobile/<name>.png
#
# `exec-out` rather than `shell screencap -p > file`: on Windows the shell
# transport translates \n to \r\n and corrupts every PNG it touches. The
# resulting file opens in nothing and the error message mentions neither adb
# nor line endings.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NAME="${1:?usage: screenshot.sh <name>}"
OUT="${SCREENSHOT_DIR:-$HOME/riseup/assets/product-screenshots/mobile}"
ADB="${ADB:-adb}"

mkdir -p "$OUT"

if [ -z "$("$ADB" devices | sed -n '2p')" ]; then
  echo "No device. Connect over USB with debugging on, or pair wireless debugging." >&2
  exit 1
fi

"$ADB" exec-out screencap -p > "$OUT/$NAME.png"

SIZE=$(wc -c < "$OUT/$NAME.png")
if [ "$SIZE" -lt 1000 ]; then
  echo "Captured $NAME.png but it is only ${SIZE}B — the screen was probably off." >&2
  exit 1
fi
echo "$OUT/$NAME.png (${SIZE}B)"
