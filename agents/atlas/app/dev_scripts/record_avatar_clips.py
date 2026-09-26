"""Dev-only tool for spec 67 — NOT part of the deployed Atlas service.

Opens one Gemini 3.8 Live session per chapter in ../../../../content/avatar.json,
with avatar_config + response_modalities=["VIDEO"], feeds it the chapter's
script under a "say this verbatim" system instruction, and writes the
resulting clip + captions to assets/video/.

Before running this:
  1. Pick the real avatar + voice in Console -> Agent Platform -> Studio ->
     Stream realtime (model gemini-3.8-live, Live Avatar panel) and update
     avatarName/voiceName in content/avatar.json. The placeholders in that
     file ("Ben" / "Puck") are documented example values, not a real pick.
  2. Have valid Vertex AI credentials for the target project
     (gcloud auth application-default login), with access to gemini-3.8-live
     confirmed via:
       gcloud ai model-garden models list --project=<PROJECT> | grep live

Usage:
  python record_avatar_clips.py --project <PROJECT> --location <LOCATION>

Requires ffmpeg on PATH if the raw video parts need remuxing into a
browser-playable .mp4 container — check the actual server_content video
part format in one interactive session first (see spec 67's Phase 0 note);
this script's remux step may need adjusting once that's confirmed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from google import genai
from google.genai import types

REPO_ROOT = Path(__file__).resolve().parents[4]
AVATAR_JSON = REPO_ROOT / "content" / "avatar.json"
VIDEO_DIR = REPO_ROOT / "assets" / "video"

SYSTEM_INSTRUCTION = (
    "You are recording a single scripted line for a portfolio site. "
    "Say the following text verbatim, once, in a warm and natural tone, "
    "then stop. Do not add anything before or after it: {script!r}"
)


async def record_chapter(client: genai.Client, model: str, avatar_name: str,
                          voice_name: str, chapter: dict) -> None:
    config = types.LiveConnectConfig(
        response_modalities=["VIDEO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
            )
        ),
        avatar_config=types.AvatarConfig(avatar_name=avatar_name),
        system_instruction=types.Content(
            parts=[types.Part.from_text(text=SYSTEM_INSTRUCTION.format(script=chapter["script"]))]
        ),
        output_audio_transcription={},
    )

    video_parts: list[bytes] = []
    transcript = ""

    async with client.aio.live.connect(model=model, config=config) as session:
        # Nudge it to start talking — the system instruction already carries
        # the script, so this just triggers the turn.
        await session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part.from_text(text="Go ahead.")]),
            turn_complete=True,
        )
        async for msg in session.receive():
            sc = msg.server_content
            if not sc:
                continue
            if sc.output_transcription and sc.output_transcription.text:
                transcript += sc.output_transcription.text
            if sc.model_turn:
                for part in sc.model_turn.parts:
                    if part.inline_data and (part.inline_data.mime_type or "").startswith("video"):
                        video_parts.append(part.inline_data.data)
            if sc.turn_complete:
                break

    if not video_parts:
        print(f"[record-avatar] {chapter['id']}: no video parts received — check avatar_name/voice_name")
        return

    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    out_path = REPO_ROOT / chapter["clip"]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        for chunk in video_parts:
            f.write(chunk)

    captions_path = REPO_ROOT / chapter["captions"]
    captions_path.write_text(
        "WEBVTT\n\n00:00:00.000 --> 00:00:30.000\n" + (transcript.strip() or chapter["script"]) + "\n",
        encoding="utf-8",
    )
    print(f"[record-avatar] wrote {out_path} ({len(video_parts)} parts) + {captions_path}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--location", default="us-central1")
    args = parser.parse_args()

    data = json.loads(AVATAR_JSON.read_text(encoding="utf-8"))
    client = genai.Client(vertexai=True, project=args.project, location=args.location)

    for chapter in data["chapters"]:
        await record_chapter(client, data["model"], data["avatarName"], data["voiceName"], chapter)


if __name__ == "__main__":
    asyncio.run(main())
