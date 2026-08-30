#!/usr/bin/env bash
# Render the "Inside Atlas" diagram to a 1080x1350 (4:5) MP4 for LinkedIn.
#
# Frames come from scripts/atlas-diagram-video/template.html, which imports the
# real buildAgentDiagram() out of assets/js/agent-widget.js, so this can never
# drift from what the site shows. Each frame is a deterministic screenshot of
# the CSS animation frozen at ?t=<seconds> (paused + negative animation-delay),
# not a screen recording, so there is no jitter and no dropped frames.
#
# Encoding uses AVFoundation via encode.swift rather than ffmpeg, which is not
# installed on this machine (nor is Homebrew).
#
# Usage:  ./scripts/atlas-diagram-video/render.sh [outdir]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/atlas-diagram-video"
OUTDIR="${1:-$HERE/out}"

# The diagram's animation cycle is exactly 7s (ad-step-seq 7s in
# components.css, with badges staggered 1s apart by agent-widget.js).
CYCLE=7
FPS=30
JOBS=4            # concurrent headless Chrome instances
PORT=5199
LOOPS=3           # repeats in the final MP4; 3 x 7s = 21s
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# The diagram's narrow layout (viewBox 300x320) rather than the wide one
# (540x250). On a 4:5 canvas carrying nothing but the diagram, the wide layout
# strands most of the frame empty; the vertical one fills it and is far more
# legible at feed size. It does shorten a few labels ("Gemini 3.7 Flash" ->
# "Gemini 3.7", "Data Corpus" -> "Corpus", "MCP Server" -> "MCP").
LAYOUT=vertical

FRAMES="$OUTDIR/frames"
rm -rf "$FRAMES"
mkdir -p "$FRAMES"

[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME" >&2; exit 1; }

# ES module imports are blocked on file://, so serve the repo over http.
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

python3 - "$PORT" <<'PY'
import sys, time, urllib.request
for _ in range(100):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/", timeout=1); sys.exit(0)
    except Exception: time.sleep(0.1)
sys.exit("server never came up")
PY

TOTAL=$(( CYCLE * FPS ))
echo "Rendering $TOTAL frames at ${FPS}fps (${CYCLE}s cycle), $JOBS at a time..."

# One frame per t. Chrome is launched per frame because --screenshot is
# single-shot; running them $JOBS-wide keeps the wall time reasonable.
# The worker lives in a temp file rather than inline in xargs, which hits
# "command line cannot be assembled, too long" with the full Chrome invocation.
WORKER="$(mktemp)"
trap 'kill $SRV 2>/dev/null || true; rm -f "$WORKER"' EXIT
cat > "$WORKER" <<WORKEREOF
#!/usr/bin/env bash
i="\$1"
t=\$(awk "BEGIN{printf \"%.4f\", \$i/$FPS}")
out=\$(printf "$FRAMES/f%04d.png" "\$i")
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \\
  --force-device-scale-factor=1 --window-size=1080,1350 \\
  --virtual-time-budget=4000 \\
  --screenshot="\$out" \\
  "http://127.0.0.1:$PORT/scripts/atlas-diagram-video/template.html?t=\$t&layout=$LAYOUT" \\
  >/dev/null 2>&1
WORKEREOF
chmod +x "$WORKER"

seq 0 $(( TOTAL - 1 )) | xargs -P "$JOBS" -n 1 "$WORKER"

COUNT=$(find "$FRAMES" -name '*.png' | wc -l | tr -d ' ')
echo "Rendered $COUNT/$TOTAL frames."
[ "$COUNT" -eq "$TOTAL" ] || { echo "frame count mismatch" >&2; exit 1; }

# `wait` after the kill keeps bash from printing a "Terminated" job notice.
kill $SRV 2>/dev/null || true
wait $SRV 2>/dev/null || true

echo "Encoding..."
# Only the looped version is produced — that's the one that gets posted, and
# a single unlooped cut has no use once the loop exists.
swift "$HERE/encode.swift" "$FRAMES" "$OUTDIR/atlas-pipeline-loop.mp4" "$FPS" "$LOOPS"

echo
echo "Done. Frames kept in $FRAMES"
ls -lh "$OUTDIR"/*.mp4
