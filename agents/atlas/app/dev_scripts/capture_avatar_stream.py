"""Capture one real avatar turn's video stream, byte for byte as relayed.

Opens the same `LiveAvatar` production uses, lets it idle briefly (as it does
while the agent thinks), has it speak a short script, and saves every video
chunk in arrival order with its arrival time. The output replays through the
browser's avatar code with no model calls, which is how a playback bug on a
machine we can't reach gets reproduced.

    uv run python -m app.dev_scripts.capture_avatar_stream OUT_DIR
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from app.app_utils import avatar_speak

SCRIPT = (
    "Gaurav is a cloud and AI architect at Deloitte. He built this site and "
    "the agents on it, including me. Ask me about his projects or certifications."
)
IDLE_S = 3.0  # the agent's thinking time, during which the face idles live


async def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    live = avatar_speak.LiveAvatar()
    t0 = time.monotonic()
    await live.open()
    chunks: list[dict] = []
    words: list[dict] = []

    async def read() -> None:
        async for kind, value in live.events():
            at = round(time.monotonic() - t0, 3)
            if kind == "video":
                path = out / f"chunk{len(chunks):04d}.bin"
                path.write_bytes(value)
                chunks.append({"file": path.name, "bytes": len(value), "at": at})
            else:
                words.append({"text": value, "at": at, "edge": round(live.clock.edge, 3)})

    reader = asyncio.ensure_future(read())
    await asyncio.sleep(IDLE_S)
    await live.say(SCRIPT)
    await asyncio.wait_for(reader, 60)
    await live.close()
    (out / "manifest.json").write_text(json.dumps({"chunks": chunks, "words": words}, indent=1))
    (out / "stream.mp4").write_bytes(b"".join((out / c["file"]).read_bytes() for c in chunks))
    print(f"{len(chunks)} chunks, {sum(c['bytes'] for c in chunks)} bytes, {len(words)} word events -> {out}")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
