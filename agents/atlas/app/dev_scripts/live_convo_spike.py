"""Spike: a hands-free avatar conversation on one gemini-3.8-live session.

Proves what an always-on conversation needs from the Live API on Vertex,
before building it (spec 71):
- turn-taking by voice activity alone, over a microphone-like stream that
  never stops (silence between questions, no explicit end signal);
- earlier chat turns seeded as history without being answered;
- a follow-up that needs that history;
- barge-in: talking over the avatar interrupts it;
- whether Vertex accepts context-window compression.

    uv run python -m app.dev_scripts.live_convo_spike

Costs about $1 of avatar speaking time.
"""

from __future__ import annotations

import asyncio
import time

from google.genai import types

from app import live_brain
from app.app_utils import avatar_speak
from app.dev_scripts.live_brain_spike import question_pcm16k

FRAME = 16000 * 2 * 40 // 1000  # 40 ms of 16 kHz PCM16
SILENCE = bytes(FRAME)


def conversation_config(compression: bool) -> types.LiveConnectConfig:
    cfg = live_brain.live_config()
    extra = dict(
        input_audio_transcription=types.AudioTranscriptionConfig(),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                silence_duration_ms=500,
            )
        ),
    )
    if compression:
        extra["context_window_compression"] = types.ContextWindowCompressionConfig(
            trigger_tokens=100_000, sliding_window=types.SlidingWindow(target_tokens=50_000)
        )
    return cfg.model_copy(update=extra)


async def _fake_send(*args, **kwargs) -> dict:
    return {"ok": True, "code": "ok", "message": "Sent (dry run)."}


async def main() -> None:
    client = avatar_speak._get_client()
    compression = True
    try:
        cm = client.aio.live.connect(model=avatar_speak.AVATAR_MODEL, config=conversation_config(True))
        session = await cm.__aenter__()
    except Exception as err:  # noqa: BLE001
        print("compression rejected:", repr(err)[:200])
        compression = False
        cm = client.aio.live.connect(model=avatar_speak.AVATAR_MODEL, config=conversation_config(False))
        session = await cm.__aenter__()
    print("context_window_compression accepted:", compression)

    dispatcher = live_brain.ToolDispatcher("convo-spike", send_resume_fn=_fake_send, send_note_fn=_fake_send)
    t0 = time.monotonic()
    now = lambda: round(time.monotonic() - t0, 2)  # noqa: E731
    log: list[tuple] = []
    audio_q: asyncio.Queue[bytes] = asyncio.Queue()
    speech_end: dict[int, float] = {}
    state = {"speaking": False, "q": 0}

    async def mic() -> None:
        # A real microphone never stops: send queued speech, else silence.
        while True:
            try:
                frame = audio_q.get_nowait()
            except asyncio.QueueEmpty:
                frame = SILENCE
            await session.send_realtime_input(audio=types.Blob(data=frame, mime_type="audio/pcm;rate=16000"))
            await asyncio.sleep(0.04)

    async def respond(calls: list[types.FunctionCall]) -> None:
        results = await asyncio.gather(*(dispatcher.run(c) for c in calls))
        await session.send_tool_response(function_responses=list(results))

    async def reader() -> None:
        while True:
            async for msg in session.receive():
                if msg.tool_call and msg.tool_call.function_calls:
                    for call in msg.tool_call.function_calls:
                        log.append((now(), "tool", call.name))
                    asyncio.ensure_future(respond(list(msg.tool_call.function_calls)))
                sc = msg.server_content
                if not sc:
                    continue
                if sc.input_transcription and sc.input_transcription.text:
                    log.append((now(), "heard", sc.input_transcription.text))
                if sc.output_transcription and sc.output_transcription.text:
                    if not state["speaking"]:
                        state["speaking"] = True
                        log.append((now(), "first_word", state["q"]))
                    log.append((now(), "said", sc.output_transcription.text))
                if sc.interrupted:
                    log.append((now(), "INTERRUPTED", ""))
                    state["speaking"] = False
                if sc.turn_complete:
                    log.append((now(), "turn_complete", ""))
                    state["speaking"] = False

    async def speak(n: int, text: str) -> None:
        pcm = await question_pcm16k(text)
        state["q"] = n
        for i in range(0, len(pcm), FRAME):
            chunk = pcm[i:i + FRAME]
            await audio_q.put(chunk + bytes(FRAME - len(chunk)))
        # The mic drains the queue at real time; speech ends when it's empty.
        while not audio_q.empty():
            await asyncio.sleep(0.02)
        speech_end[n] = time.monotonic()
        log.append((now(), f"Q{n} speech ended", text))

    rd = asyncio.ensure_future(reader())
    mc = asyncio.ensure_future(mic())
    try:
        # 1. History, not to be answered on its own.
        history = [
            types.Content(role="user", parts=[types.Part.from_text(text="Which Google Cloud certifications does Gaurav hold?")]),
            types.Content(role="model", parts=[types.Part.from_text(text="He holds five Google Cloud certifications, including Associate Cloud Engineer and Professional Security Engineer.")]),
        ]
        await session.send_client_content(turns=history, turn_complete=False)
        log.append((now(), "history sent", ""))
        await asyncio.sleep(4)

        # 2. Q1, answered by voice activity alone.
        await speak(1, "What has Gaurav shipped in production?")
        await asyncio.sleep(14)
        # 3. Q2, a follow-up that needs the history.
        await speak(2, "And what about his AWS ones?")
        # 4. Q3 over the top of Q2's answer, about 1.5 s after it starts.
        for _ in range(200):
            if state["speaking"]:
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(1.5)
        await speak(3, "Where does he work now?")
        await asyncio.sleep(14)
    finally:
        mc.cancel()
        rd.cancel()
        await cm.__aexit__(None, None, None)

    for entry in log:
        if entry[1] != "said":
            print(entry)
    print("\nSAID:", " | ".join(e[2] for e in log if e[1] == "said"))
    fw = [e for e in log if e[1] == "first_word"]
    for n, end in speech_end.items():
        first = next((e[0] for e in fw if e[2] == n and e[0] >= end - t0), None)
        print(f"Q{n}: speech end -> first word = {None if first is None else round(first - (end - t0), 2)} s")
    print("tools:", [c["name"] for c in dispatcher.calls])


if __name__ == "__main__":
    asyncio.run(main())
