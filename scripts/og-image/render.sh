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

# Inline the portrait and any {{BADGE:<slug>}} (assets/img/badges/<slug>.png)
# as base64 data URIs.
python3 - "$TPL" "$TMP/final.html" "$PORTRAIT" "$ROOT/assets/img/badges" <<'PY'
import base64, re, sys
tpl, out, portrait, badges = sys.argv[1:5]
def uri(path):
    return "data:image/png;base64," + base64.b64encode(open(path, "rb").read()).decode()
html = open(tpl, encoding="utf-8").read()
html = html.replace("{{PORTRAIT}}", uri(portrait))
html = re.sub(r"\{\{BADGE:([a-z0-9-]+)\}\}", lambda m: uri(f"{badges}/{m.group(1)}.png"), html)
open(out, "w", encoding="utf-8").write(html)
PY

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1200,630 \
  --default-background-color=00000000 --virtual-time-budget=5000 \
  --screenshot="$OUT" "file://$TMP/final.html" >/dev/null 2>&1

rm -rf "$TMP"
echo "Wrote $OUT"
