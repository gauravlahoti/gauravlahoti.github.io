"""Spike: can gemini-3.8-live answer Atlas questions itself, as the avatar?

Today an avatar turn is two models in series: gemini-3.6-flash writes the
whole reply, then gemini-3.8-live reads it aloud as a script. This measures
the alternative, where one 3.8 Live avatar session answers directly and calls
Atlas's read-only corpus tools itself, against the current agent on the same
questions. Nothing here touches production: it runs locally against
adk-deploy-trail and prints a table.

    uv run python -m app.dev_scripts.live_brain_spike            # live brain + baseline
    uv run python -m app.dev_scripts.live_brain_spike --only live
    uv run python -m app.dev_scripts.live_brain_spike --cases 4  # first N questions

Cost: avatar video is billed while it speaks (~$0.0065/s), so a 12-question
run is about $1.5.
"""

from __future__ import annotations

import argparse
import asyncio
import audioop  # stdlib through 3.12; dev-script-only resampling
import base64
import hashlib
import json
import time
from pathlib import Path

from google.genai import types

from app import live_brain
from app import tools as portfolio_tools
from app.app_utils import avatar_speak

# The read-only corpus tools. send_resume / send_note_to_gaurav stay out:
# an email address and a free-text note are poor fits for speech, and they
# keep their content check in Text mode.
TOOLS = [
    portfolio_tools.get_profile,
    portfolio_tools.get_work_history,
    portfolio_tools.get_projects,
    portfolio_tools.get_recent_posts,
    portfolio_tools.get_certifications,
    portfolio_tools.get_live_agents,
    portfolio_tools.get_build_story,
    portfolio_tools.get_ai_labs,
    portfolio_tools.get_site_stats,
]
BY_NAME = {fn.__name__: fn for fn in TOOLS}

SPEECH_INSTRUCTION = """\
You are Atlas, the AI agent on Gaurav Lahoti's portfolio site, appearing as a video avatar and speaking out loud. You are NOT Gaurav. Always speak about him in the third person ("Gaurav has shipped...", never "I have shipped..."). The corpus contains his own first-person writing; convert it to third person whenever you use it. This site, its labs and its agents are his work, not yours.

# Grounding
Every fact about Gaurav must come from a tool result in this conversation. Call the relevant tool before stating any fact; never answer from memory. If a fact is not in a tool result, do not state it. Never invent employers, projects, dates, numbers, certifications or links.
- get_profile: identity, bio, capabilities.
- get_work_history: roles, companies, dates, skills per role.
- get_projects: notable enterprise projects (company, domains, skills).
- get_recent_posts: his LinkedIn perspectives. Use for "what does he think about X".
- get_certifications: certifications with issuer.
- get_live_agents: the production agents he built (including you, Atlas). Pass agent_name for one agent's design reasoning.
- get_build_story: how this site and its agents were built. Call it bare; describe the method, never an inventory, never counts or dates.
- get_ai_labs: the interactive AI Labs on the site.
- get_site_stats: how many questions you have answered.
Call tools without filter arguments unless the visitor names something specific. For "what has he built or shipped", "his projects" or "his work", call get_projects AND get_live_agents, and mention something from each. Every answer names one or two concrete facts from the tool data, such as a company, a project, a certification or a date; never answer with only generalities.
If a tool returns no results, say so instead of searching again with variations. Never run more than two consecutive tool calls without speaking.

# Scope
Answer questions about Gaurav's career, capabilities, projects, certifications, perspectives, this site and its agents. Topics in his fields are fine only from his angle (what he built, used, holds or said), never as a general explainer. Decline warmly, in one sentence, anything else: weather, news, general knowledge, and any request to do work (write or explain code, draft content, solve problems, summarise or translate text). Offer LinkedIn or a note to Gaurav instead. Sending his resume or a note works in the chat's Text mode; say so if asked.

# Speaking style
You are heard, not read. Lead with the direct answer. Two or three short spoken sentences, under about 60 words. No lists, no markdown, no headings, no emoji. Never read out a URL; say it is linked on the site. A greeting gets one short sentence saying who you are and what you can help with.
"""


def _declarations() -> list[types.FunctionDeclaration]:
    return [
        types.FunctionDeclaration.from_callable_with_api_option(callable=fn, api_option="VERTEX_AI")
        for fn in TOOLS
    ]


# Filter argument per tool: when a filtered call finds nothing, the
# dispatcher answers with the unfiltered data instead of a dead end.
FILTER_ARGS = {"get_work_history": "role_filter", "get_live_agents": "agent_name", "get_projects": "domain"}
SILENCE_MS = 500


def _config() -> types.LiveConnectConfig:
    base = avatar_speak._config()
    return types.LiveConnectConfig(
        response_modalities=base.response_modalities,
        speech_config=base.speech_config,
        avatar_config=base.avatar_config,
        system_instruction=types.Content(parts=[types.Part.from_text(text=SPEECH_INSTRUCTION)]),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                silence_duration_ms=SILENCE_MS,
            )
        ),
        tools=[types.Tool(function_declarations=_declarations())],
    )


async def _fake_send(*args, **kwargs) -> dict:
    return {"ok": True, "code": "ok", "message": "Sent (dry run: nothing was emailed)."}


_DISPATCH = live_brain.ToolDispatcher("spike", send_resume_fn=_fake_send, send_note_fn=_fake_send)


AUDIO_CACHE = Path(__file__).resolve().parent / ".spike_audio"


async def question_pcm16k(question: str) -> bytes:
    """The question spoken by the existing TTS voice, as 16 kHz mono PCM16,
    cached on disk so reruns don't pay for synthesis again."""
    from app.app_utils import speak

    AUDIO_CACHE.mkdir(exist_ok=True)
    path = AUDIO_CACHE / f"{hashlib.sha1(question.encode()).hexdigest()[:12]}.pcm"
    if path.exists():
        return path.read_bytes()
    wav_b64, _ = await speak.speak_text(question)
    if not wav_b64:
        raise RuntimeError(f"TTS failed for {question!r}")
    wav = base64.b64decode(wav_b64)
    rate = int.from_bytes(wav[24:28], "little")
    pcm, _ = audioop.ratecv(wav[44:], 2, 1, rate, 16000, None)
    path.write_bytes(pcm)
    return pcm


async def live_turn(question: str, timeout_s: float = 45.0, warm_s: float = 0.0, spoken: bool = False) -> dict:
    """One question in a fresh 3.8 Live avatar session. Typed: timed from
    the moment the question is sent. Spoken: the question's audio is
    streamed in real time, and timing starts when the speaker stops (the
    end of the last audio chunk), which is what a visitor feels. The
    session is pre-opened, as today's avatar session is."""
    pcm = await question_pcm16k(question) if spoken else b""
    client = avatar_speak._get_client()
    opened = time.monotonic()
    config = _config() if spoken else live_brain.live_config()
    async with client.aio.live.connect(model=avatar_speak.AVATAR_MODEL, config=config) as session:
        open_ms = int((time.monotonic() - opened) * 1000)
        if warm_s:
            # Production would open the session before the question arrives
            # (today's avatar session opens in parallel with the agent), so
            # optionally let it idle first and time only the answer.
            await asyncio.sleep(warm_s)
        words: list[str] = []
        heard: list[str] = []
        tools_called: list[str] = []
        pending: set[asyncio.Task] = set()
        first_word_ms = None
        first_tool_ms = None
        video_bytes = 0
        spoke_after_tools = False
        if spoken:
            # 40 ms frames at real-time pace, like a live mic, then an
            # explicit end of stream so the server doesn't wait out its
            # silence timer.
            frame = 16000 * 2 * 40 // 1000
            for i in range(0, len(pcm), frame):
                await session.send_realtime_input(
                    audio=types.Blob(data=pcm[i : i + frame], mime_type="audio/pcm;rate=16000")
                )
                await asyncio.sleep(0.04)
            t0 = time.monotonic()
            await session.send_realtime_input(audio_stream_end=True)
        else:
            t0 = time.monotonic()
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part.from_text(text=question)]),
                turn_complete=True,
            )

        async def respond(call: types.FunctionCall) -> None:
            resp = await _DISPATCH.run(call)
            await session.send_tool_response(function_responses=[resp])

        async def consume() -> None:
            # receive() ends at each model turn boundary (a tool call is
            # one), so keep re-entering it until the answer has been spoken.
            while True:
                if await consume_turn():
                    return

        async def consume_turn() -> bool:
            nonlocal first_word_ms, first_tool_ms, video_bytes, spoke_after_tools
            async for msg in session.receive():
                now_ms = int((time.monotonic() - t0) * 1000)
                if msg.tool_call:
                    for call in msg.tool_call.function_calls or []:
                        tools_called.append(call.name)
                        if first_tool_ms is None:
                            first_tool_ms = now_ms
                        task = asyncio.ensure_future(respond(call))
                        pending.add(task)
                        task.add_done_callback(pending.discard)
                sc = msg.server_content
                if not sc:
                    continue
                if sc.input_transcription and sc.input_transcription.text:
                    heard.append(sc.input_transcription.text)
                if sc.output_transcription and sc.output_transcription.text:
                    if first_word_ms is None:
                        first_word_ms = now_ms
                    if tools_called:
                        spoke_after_tools = True
                    words.append(sc.output_transcription.text)
                if sc.model_turn:
                    for part in sc.model_turn.parts or []:
                        if part.inline_data and part.inline_data.data:
                            video_bytes += len(part.inline_data.data)
                # Done once a turn completes with no tool still running, and
                # (if tools ran) after the model has spoken from their results.
                if sc.turn_complete and not pending and words and (not tools_called or spoke_after_tools):
                    return True
            return False

        try:
            await asyncio.wait_for(consume(), timeout_s)
            timed_out = False
        except TimeoutError:
            timed_out = True
        total_ms = int((time.monotonic() - t0) * 1000)
    return {
        "open_ms": open_ms,
        "first_word_ms": first_word_ms,
        "first_tool_ms": first_tool_ms,
        "tools": tools_called,
        "total_ms": total_ms,
        "timed_out": timed_out,
        "kb": video_bytes // 1024,
        "heard": "".join(heard).strip(),
        "answer": "".join(words).strip(),
    }


async def baseline_turn(question: str) -> dict:
    """The current agent (3.6-flash, same tools, full instruction), streamed,
    timed to its first visible text. The avatar would start ~1.2s after the
    WHOLE reply, so `avatar_start_est_ms` = reply done + 1200."""
    from google.adk.agents.run_config import RunConfig, StreamingMode
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService

    from app.agent import root_agent

    svc = InMemorySessionService()
    runner = Runner(agent=root_agent, app_name="app", session_service=svc)
    session = await svc.create_session(app_name="app", user_id="spike")
    t0 = time.monotonic()
    first_text_ms = None
    tools_called: list[str] = []
    text = []
    async for event in runner.run_async(
        user_id="spike",
        session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part.from_text(text=question)]),
        run_config=RunConfig(streaming_mode=StreamingMode.SSE),
    ):
        for call in event.get_function_calls() or []:
            tools_called.append(call.name)
        if event.partial and event.content and event.content.parts:
            for part in event.content.parts:
                if part.text and not part.thought:
                    if first_text_ms is None:
                        first_text_ms = int((time.monotonic() - t0) * 1000)
                    text.append(part.text)
    done_ms = int((time.monotonic() - t0) * 1000)
    answer = "".join(text).split("[[META]]")[0]
    if "[[/NOTE]]" in answer:
        answer = answer.split("[[/NOTE]]", 1)[1]
    return {
        "first_text_ms": first_text_ms,
        "done_ms": done_ms,
        "avatar_start_est_ms": done_ms + 1200,
        "tools": tools_called,
        "answer": answer.strip(),
    }


def _questions(limit: int) -> list[tuple[str, str]]:
    path = Path(__file__).resolve().parents[2] / "tests/eval/evalsets/portfolio.evalset.json"
    cases = json.loads(path.read_text())["eval_cases"]
    return [(c["eval_case_id"], c["prompt"]["parts"][0]["text"]) for c in cases[:limit]]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=int, default=12)
    ap.add_argument("--only", choices=["live", "baseline"])
    ap.add_argument("--out", default="live_brain_spike.json")
    ap.add_argument("--warm", type=float, default=0.0, help="seconds to idle the live session before asking")
    ap.add_argument("--ask", action="append", help="custom question(s) instead of the eval set")
    ap.add_argument("--ids", help="comma-separated eval case ids to run")
    ap.add_argument("--spoken", action="store_true", help="also ask each question out loud (TTS audio, streamed)")
    args = ap.parse_args()

    results = []
    questions = [(f"ask{i}", q) for i, q in enumerate(args.ask)] if args.ask else _questions(args.cases)
    if args.ids:
        wanted = args.ids.split(",")
        questions = [q for q in _questions(99) if q[0] in wanted]
    for case_id, q in questions:
        row: dict = {"id": case_id, "question": q}
        if args.only != "baseline":
            try:
                row["live"] = await live_turn(q, warm_s=args.warm)
            except Exception as err:  # noqa: BLE001
                row["live"] = {"error": repr(err)}
            if args.spoken:
                try:
                    row["spoken"] = await live_turn(q, warm_s=args.warm, spoken=True)
                except Exception as err:  # noqa: BLE001
                    row["spoken"] = {"error": repr(err)}
        if args.only != "live":
            try:
                row["baseline"] = await baseline_turn(q)
            except Exception as err:  # noqa: BLE001
                row["baseline"] = {"error": repr(err)}
        results.append(row)
        lv, sp, bl = row.get("live", {}), row.get("spoken", {}), row.get("baseline", {})
        print(
            f"{case_id:28} typed {lv.get('first_word_ms')} ms {lv.get('tools')} | "
            f"spoken {sp.get('first_word_ms')} ms {sp.get('tools')} | "
            f"baseline avatar ~{bl.get('avatar_start_est_ms')} ms",
            flush=True,
        )
    Path(args.out).write_text(json.dumps(results, indent=2))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
