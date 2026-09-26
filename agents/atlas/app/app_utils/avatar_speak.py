"""Atlas's avatar voice (spec 67): Gemini 3.8 Live Avatar speaks a reply.

In the widget's Avatar mode the avatar speaks each reply instead of the TTS
voice in `speak.py`, and it happens inside the chat request itself:

1. The chat turn opens a Live session as the avatar *in parallel* with the
   agent thinking. An open session streams the avatar idling live (blinking,
   breathing), so the face is alive while Atlas works.
2. The moment the reply is written, its cleaned speech text goes into that
   already-open session as a script, and the avatar starts talking ~1.2s
   later. (A cold session would add ~3s of setup on top.)
3. Video and the avatar's own speech transcription are relayed on the same
   SSE stream as the text, so the browser needs no second request.

Because the server only ever speaks the reply it just generated, nobody can
make the face say arbitrary text. Two caps keep cost bounded: the `avatar`
bucket in `rate_limit.py` (per visitor) and `AvatarBudget` below (per day, in
speaking-seconds; per instance like the rate limiter, so the true ceiling is
budget x max-instances).

Measured on adk-deploy-trail (spec 67): session setup ~3.1s; text to first
spoken word on a warm session ~1.2s, verbatim (28/28 words); generation at
about real time; 600 kbps keeps a 17s answer to ~1.6 MB (the default ~8 Mbps
is too heavy for phones). Idle video before the script arrives runs at
roughly 360 kbps.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from google import genai
from google.genai import types

from app.fallback_model import ATLAS_VERTEX_PROJECT

logger = logging.getLogger(__name__)

AVATAR_MODEL = "gemini-3.8-live"
AVATAR_NAME = "Sam"   # picked by hand in Console; must match content/avatar.json
VOICE_NAME = "Puck"
# Live Avatar is served from regional endpoints (US/EU), not the "global"
# location the chat agent uses.
AVATAR_LOCATION = "us-central1"
VIDEO_BITRATE_BPS = 600_000
AUDIO_BITRATE_BPS = 48_000

# Longest reply the avatar will speak, in characters of cleaned speech text.
# ~140 words, under a minute. Replies are asked to stay under 120 words, so
# this rarely bites; when it does, it cuts at a sentence end.
MAX_SPEECH_CHARS = 900
# What a turn reserves against the day's budget before the reply exists;
# settled against the measured speaking time afterwards.
RESERVE_SECONDS = 30.0
# Published rates (spec 67): avatar video at 6,192 tokens/s x $1/M, audio at
# 25 tokens/s x $12/M. Billed only while the avatar speaks.
USD_PER_SPEAKING_SECOND = 6192 / 1e6 * 1.0 + 25 / 1e6 * 12.0
# ~$5/day at the rate above.
DAILY_BUDGET_SECONDS = 13 * 60

SCRIPT_INSTRUCTION = (
    "You are the video avatar for Atlas, the AI agent on Gaurav Lahoti's "
    "portfolio site. You never answer, greet, or comment. Every message you "
    "receive is a script: say it aloud exactly as written, word for word, "
    "once, in a warm, natural, conversational tone, then stop and wait."
)

# --- speech text ------------------------------------------------------------

_SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")


def clip_to_sentences(text: str, limit: int = MAX_SPEECH_CHARS) -> str:
    """Longest run of whole sentences that fits in `limit` characters."""
    text = text.strip()
    if len(text) <= limit:
        return text
    out = ""
    for sentence in _SENTENCE_END_RE.split(text):
        candidate = f"{out} {sentence}".strip()
        if len(candidate) > limit:
            break
        out = candidate
    # One enormous sentence: fall back to a word boundary.
    return out or text[:limit].rsplit(" ", 1)[0]


class ScriptAligner:
    """Turn the avatar's streamed transcription into clean caption text.

    The Live API's output transcription sometimes drops the spaces between
    chunks ("full-timeat", "considersselect"), and never sees paragraph
    breaks. The avatar reads a script we wrote, verbatim, so each chunk is
    matched against that script (ignoring whitespace differences) and the
    script's own slice is emitted instead: exact spacing, punctuation,
    casing and paragraph breaks. A chunk that can't be placed is passed
    through with a space, and is never repeated by a later match.
    """

    # How far ahead of the last match a chunk may land and still count.
    MAX_SKIP = 200
    _WS = re.compile(r"\s+")

    def __init__(self, script: str) -> None:
        self._script = script
        # Whitespace-collapsed, lower-cased script, plus where each of its
        # characters sits in the original, so matches map back exactly.
        norm, where, prev_ws = [], [], False
        for i, ch in enumerate(script):
            if ch.isspace():
                if not prev_ws and norm:
                    norm.append(" ")
                    where.append(i)
                prev_ws = True
            else:
                norm.append(ch.lower())
                where.append(i)
                prev_ws = False
        self._norm = "".join(norm)
        self._where = where
        self._at = 0        # original index: end of the last emitted slice
        self._nat = 0       # normalized index of the same point
        self._shown = False
        self._matched = False
        self._skipped = False  # a chunk was passed through since the last match

    def feed(self, chunk: str) -> str:
        core = self._WS.sub(" ", chunk).strip()
        if not core:
            return ""
        j = self._norm.find(core.lower(), self._nat)
        if j == -1 or j - self._nat > self.MAX_SKIP:
            out = (" " if self._shown and core[0] not in ".,;:!?)" else "") + core
            self._skipped = True
        else:
            nend = j + len(core)
            end = self._where[nend - 1] + 1
            # From the last match (keeping the script's spacing and breaks),
            # unless something was passed through since: then from this
            # match, so the skipped span is never shown twice.
            start = self._at if (self._matched and not self._skipped) else self._where[j]
            out = self._script[start:end]
            if self._shown and not out[:1].isspace() and out[:1] not in ".,;:!?)":
                out = " " + out
            self._at, self._nat = end, nend
            self._matched, self._skipped = True, False
        self._shown = True
        return out

    def rest(self) -> str:
        """Whatever the transcription skipped at the end, so captions finish
        complete. Only once the captions were actually tracking the script."""
        if not self._matched or self._skipped:
            return ""
        out = self._script[self._at:]
        self._at = len(self._script)
        return out


# --- daily budget -----------------------------------------------------------


class AvatarBudget:
    """Speaking-seconds per UTC day. Reserve up front, settle with actuals."""

    def __init__(self, daily_seconds: float = DAILY_BUDGET_SECONDS) -> None:
        self._daily = daily_seconds
        self._lock = threading.Lock()
        self._day = ""
        self._used = 0.0

    def _roll(self) -> None:
        today = datetime.now(UTC).strftime("%Y-%m-%d")
        if today != self._day:
            self._day, self._used = today, 0.0

    def reserve(self, seconds: float) -> bool:
        with self._lock:
            self._roll()
            if self._used + seconds > self._daily:
                return False
            self._used += seconds
            return True

    def settle(self, reserved: float, actual: float) -> None:
        with self._lock:
            self._roll()
            self._used = max(0.0, self._used - reserved + actual)

    @property
    def used_seconds(self) -> float:
        with self._lock:
            self._roll()
            return self._used


budget = AvatarBudget()

# --- the Live session -------------------------------------------------------

_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(vertexai=True, project=ATLAS_VERTEX_PROJECT, location=AVATAR_LOCATION)
    return _client


def _config() -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["VIDEO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE_NAME)
            )
        ),
        avatar_config=types.AvatarConfig(
            avatar_name=AVATAR_NAME,
            video_bitrate_bps=VIDEO_BITRATE_BPS,
            audio_bitrate_bps=AUDIO_BITRATE_BPS,
        ),
        system_instruction=types.Content(parts=[types.Part.from_text(text=SCRIPT_INSTRUCTION)]),
        # The avatar's own words, streamed back as the visitor's live transcript.
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )


class LiveAvatar:
    """One avatar session for one chat turn.

    `open()` connects; `events()` yields ("video", bytes) and ("words", str)
    from the moment it opens (idle video first), and ends once the script
    passed to `say()` has been spoken. `close()` is safe to call any time.
    """

    def __init__(self) -> None:
        self._cm = None
        self._session = None
        self._said = False
        self.words_first_at: float | None = None
        self.last_media_at: float | None = None
        self.bytes = 0

    async def open(self) -> None:
        self._cm = _get_client().aio.live.connect(model=AVATAR_MODEL, config=_config())
        try:
            self._session = await self._cm.__aenter__()
        except BaseException:
            self._cm = None
            raise

    async def say(self, text: str) -> None:
        self._said = True
        await self._session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part.from_text(text=text)]),
            turn_complete=True,
        )

    async def events(self) -> AsyncIterator[tuple[str, object]]:
        async for msg in self._session.receive():
            sc = msg.server_content
            if not sc:
                continue
            if sc.output_transcription and sc.output_transcription.text:
                if self.words_first_at is None:
                    self.words_first_at = time.monotonic()
                yield ("words", sc.output_transcription.text)
            if sc.model_turn:
                for part in sc.model_turn.parts or []:
                    data = part.inline_data
                    if data and (data.mime_type or "").startswith("video") and data.data:
                        self.bytes += len(data.data)
                        if self.words_first_at is not None:
                            self.last_media_at = time.monotonic()
                        yield ("video", data.data)
            if sc.turn_complete and self._said:
                return

    @property
    def spoken_seconds(self) -> float:
        # From the first spoken word to the last frame after it. Generation
        # runs at about real time (measured), so this tracks media duration.
        if self.words_first_at is None or self.last_media_at is None:
            return 0.0
        return max(0.0, self.last_media_at - self.words_first_at)

    async def close(self) -> None:
        cm, self._cm = self._cm, None
        if cm is not None:
            try:
                await cm.__aexit__(None, None, None)
            except Exception:  # closing a dead socket is not an error worth surfacing
                logger.debug("avatar session close failed", exc_info=True)
