#!/usr/bin/env bash
# Render the Open Graph card (scripts/og-image/template.html) to
# assets/img/og-image.jpg at 1200x630 using headless Chrome.
#
# JPEG, not PNG: WhatsApp silently drops link-preview images over ~300 KB,
# and the PNG of this card is ~285 KB. JPEG q90 is ~105 KB with no visible
# loss. The script fails if the JPEG creeps past 280 KB.
#
# Usage:  ./scripts/og-image/render.sh
# Edit template.html, then re-run this. The portrait and badges are inlined
# as base64 so the render is self-contained (no --allow-file-access needed).
# After a re-render, bump the og-image.jpg ?v= in index.html.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TPL="$ROOT/scripts/og-image/template.html"
PORTRAIT="$ROOT/assets/img/portrait.png"
OUT="$ROOT/assets/img/og-image.jpg"
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
  --screenshot="$TMP/card.png" "file://$TMP/final.html" >/dev/null 2>&1

python3 - "$TMP/card.png" "$OUT" <<'PY'
import os, sys
from PIL import Image
src, out = sys.argv[1:3]
Image.open(src).convert("RGB").save(out, "JPEG", quality=90, optimize=True,
                                    progressive=True, subsampling=0)
kb = os.path.getsize(out) / 1024
print(f"{kb:.0f} KB")
if kb > 280:
    sys.exit("og-image.jpg is over 280 KB; WhatsApp will drop the preview")
PY

rm -rf "$TMP"
echo "Wrote $OUT"
