#!/usr/bin/env bash
# Render the Open Graph card (scripts/og-image/template.html) to
# assets/img/og-image.png at 1200x630 using headless Chrome.
#
# Usage:  ./scripts/og-image/render.sh
# Edit template.html, then re-run this. The portrait is inlined as base64
# so the render is self-contained (no --allow-file-access needed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TPL="$ROOT/scripts/og-image/template.html"
PORTRAIT="$ROOT/assets/img/portrait.png"
OUT="$ROOT/assets/img/og-image.png"
TMP="$(mktemp -d)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Inline the portrait as a base64 data URI.
B64="$(base64 < "$PORTRAIT" | tr -d '\n')"
python3 - "$TPL" "$TMP/final.html" "$B64" <<'PY'
import sys
tpl, out, b64 = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(tpl, encoding="utf-8").read()
html = html.replace("{{PORTRAIT}}", "data:image/png;base64," + b64)
open(out, "w", encoding="utf-8").write(html)
PY

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1200,630 \
  --default-background-color=00000000 \
  --screenshot="$OUT" "file://$TMP/final.html" >/dev/null 2>&1

rm -rf "$TMP"
echo "Wrote $OUT"
