"""Text-to-speech for Atlas's spoken replies.

The third box of the pipeline. `transcribe.py` turns a recorded clip into
text, the agent reasons over it, and this turns the answer back into audio.
See `.claude/specs/49-atlas-spoken-replies.md`.

Primary model is `gemini-3.1-flash-tts-preview` (April 2026), the newest TTS
model and the only one that accepts a natural-language style instruction on
top of expressive audio tags. That instruction is the whole reason for
choosing Gemini TTS over Cloud TTS's Chirp 3 HD, which is cheaper but has no
style control at all and makes Atlas sound like a newsreader.

`gemini-2.5-flash-tts` (GA, half the output price) is the cascade fallback on
404/429/503 — availability redundancy, the same rationale as `FallbackGemini`
and `transcribe.py`, not a hedge against the primary being bad.

Both IDs were resolved from `gcloud ai model-garden models list` rather than
the public docs, per the rule in CLAUDE.md. Spec 48 lost an afternoon to
`gemini-3.5-transcribe` 404ing because the callable publisher ID carried a
`-preview` suffix the docs never printed; `gemini-3.1-flash-tts-preview`
carries one too.

Vertex `generateContent` returns headerless PCM (24 kHz, 16-bit signed LE,
mono) as base64. Prepending a 44-byte RIFF header here means the browser can
play the result from a plain `<audio>` element with no AudioContext, no
AudioWorklet, and no PCM handling of its own.
"""

from __future__ import annotations

import base64
import logging
import re
import struct
import time
from typing import Any

import google.auth
import google.auth.transport.requests
import httpx

from app.fallback_model import ATLAS_VERTEX_LOCATION, ATLAS_VERTEX_PROJECT

logger = logging.getLogger(__name__)

SPEAK_MODEL = "gemini-3.1-flash-tts-preview"
FALLBACK_MODEL = "gemini-2.5-flash-tts"

# One of the 28 prebuilt voices. Charon is catalogued as "informative", which
# suits an agent that mostly explains architecture decisions. Iapetus (clear)
# and Sulafat (warm) are the two worth auditioning against it.
VOICE_NAME = "Charon"

# Gemini TTS takes its style direction as plain language prefixed to the text.
# Kept deliberately plain: the failure mode of an over-directed prompt is the
# model performing the instruction rather than reading the sentence.
STYLE_PROMPT = (
    "Read the following aloud like a calm, precise cloud architect explaining "
    "something to a peer. Unhurried and warm, no hype, no salesmanship. "
    "Read only the text, do not add commentary:"
)

# Vertex caps TTS input well above this; the real reason for a cap here is
# that one sentence chunk should never be long enough to be worth an
# expensive call. The frontend splits at ~300 chars, so this is generous
# headroom rather than a limit legitimate traffic meets.
MAX_TEXT_CHARS = 1200

# 24 kHz, 16-bit signed little-endian, mono — what the TTS models return.
# Parsed from the response mimeType where present, these are the fallbacks.
DEFAULT_SAMPLE_RATE = 24000
SAMPLE_WIDTH_BYTES = 2
CHANNELS = 1

_TIMEOUT_S = 30.0

_creds: google.auth.credentials.Credentials | None = None
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Cached keep-alive client — same rationale as `transcribe.py`'s: a fresh
    `httpx.AsyncClient` per call means a full TLS handshake to
    aiplatform.googleapis.com every time, and sentence-chunked synthesis makes
    several calls per reply. Never explicitly closed; the process dies with
    the Cloud Run container."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=_TIMEOUT_S)
    return _client


def _get_credentials() -> google.auth.credentials.Credentials:
    """Cached ADC credentials, refreshed in place.

    Forces the same Vertex project/location Atlas's chat model uses, never the
    ambient `GEMINI_API_KEY` path, so this route can't inherit the AI Studio
    free-tier 503s or spend cap that chat was moved off of.
    """
    global _creds
    if _creds is None:
        _creds, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
    if not _creds.valid:
        _creds.refresh(google.auth.transport.requests.Request())
    return _creds


def _model_url(model: str) -> str:
    return (
        f"https://aiplatform.googleapis.com/v1/projects/{ATLAS_VERTEX_PROJECT}"
        f"/locations/{ATLAS_VERTEX_LOCATION}/publishers/google/models/"
        f"{model}:generateContent"
    )


# --- text sanitization ----------------------------------------------------

_META_RE = re.compile(r"\[\[META\]\].*?\[\[/META\]\]", re.DOTALL)
_URL_RE = re.compile(r"https?://\S+|www\.\S+")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((?:[^)]+)\)")
_CITATION_RE = re.compile(r"\[\d+\]")
_CODE_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_EMPHASIS_RE = re.compile(r"(\*{1,2}|_{1,2})(\S.*?\S|\S)\1")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_BULLET_RE = re.compile(r"^\s*[-*+]\s+", re.MULTILINE)
_WS_RE = re.compile(r"[ \t]+")
_BLANKS_RE = re.compile(r"\n{3,}")


def sanitize_for_speech(text: str) -> str:
    """Strip everything that reads badly aloud.

    A model reading "h t t p s colon slash slash" is the fastest way to make
    this feel broken, and citation markers turn every sourced sentence into
    "bracket one". Markdown link text is kept and the target dropped, so
    "see [the spec](https://…)" speaks as "see the spec".
    """
    if not text:
        return ""
    out = _META_RE.sub(" ", text)
    out = _CODE_FENCE_RE.sub(" ", out)
    out = _MD_LINK_RE.sub(r"\1", out)
    out = _URL_RE.sub(" ", out)
    out = _CITATION_RE.sub(" ", out)
    out = _INLINE_CODE_RE.sub(r"\1", out)
    out = _EMPHASIS_RE.sub(r"\2", out)
    out = _HEADING_RE.sub("", out)
    out = _BULLET_RE.sub("", out)
    out = _WS_RE.sub(" ", out)
    out = _BLANKS_RE.sub("\n\n", out)
    return out.strip()


# --- PCM → WAV ------------------------------------------------------------

def wav_header(pcm_bytes: int, sample_rate: int = DEFAULT_SAMPLE_RATE) -> bytes:
    """Build the 44-byte canonical RIFF/WAVE header for mono 16-bit PCM.

    This is the entire reason the browser needs no audio plumbing: with a
    header in front, the payload is a file an `<audio>` element plays.
    """
    byte_rate = sample_rate * CHANNELS * SAMPLE_WIDTH_BYTES
    block_align = CHANNELS * SAMPLE_WIDTH_BYTES
    return (
        b"RIFF"
        + struct.pack("<I", 36 + pcm_bytes)
        + b"WAVEfmt "
        + struct.pack("<I", 16)          # PCM fmt chunk size
        + struct.pack("<H", 1)           # audio format 1 = PCM
        + struct.pack("<H", CHANNELS)
        + struct.pack("<I", sample_rate)
        + struct.pack("<I", byte_rate)
        + struct.pack("<H", block_align)
        + struct.pack("<H", SAMPLE_WIDTH_BYTES * 8)
        + b"data"
        + struct.pack("<I", pcm_bytes)
    )


def pcm_to_wav(pcm: bytes, sample_rate: int = DEFAULT_SAMPLE_RATE) -> bytes:
    return wav_header(len(pcm), sample_rate) + pcm


def _sample_rate_from_mime(mime: str) -> int:
    """`audio/L16;codec=pcm;rate=24000` → 24000.

    Trusting the response over the documented default: a model that ever
    returns 16 kHz would otherwise play back chipmunked, which is the classic
    PCM bug and easy to prevent here.
    """
    match = re.search(r"rate=(\d+)", mime or "")
    if not match:
        return DEFAULT_SAMPLE_RATE
    try:
        rate = int(match.group(1))
    except ValueError:
        return DEFAULT_SAMPLE_RATE
    return rate if 8000 <= rate <= 48000 else DEFAULT_SAMPLE_RATE


def _extract_audio(payload: dict[str, Any]) -> tuple[bytes, int]:
    """Pull base64 PCM out of a generateContent response. Returns (pcm, rate)."""
    candidates = payload.get("candidates") or []
    if not candidates:
        return b"", DEFAULT_SAMPLE_RATE
    parts = ((candidates[0] or {}).get("content") or {}).get("parts") or []
    for part in parts:
        if not isinstance(part, dict):
            continue
        inline = part.get("inlineData") or part.get("inline_data")
        if not isinstance(inline, dict):
            continue
        data = inline.get("data")
        if not data:
            continue
        try:
            pcm = base64.b64decode(data)
        except Exception:
            continue
        return pcm, _sample_rate_from_mime(inline.get("mimeType") or "")
    return b"", DEFAULT_SAMPLE_RATE


async def _call_model(
    client: httpx.AsyncClient, token: str, model: str, text: str
) -> httpx.Response:
    return await client.post(
        _model_url(model),
        headers={"Authorization": f"Bearer {token}"},
        json={
            "contents": [
                {"role": "user", "parts": [{"text": f"{STYLE_PROMPT}\n\n{text}"}]}
            ],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {"voiceName": VOICE_NAME}
                    }
                },
            },
        },
    )


async def speak_text(text: str) -> tuple[str | None, str]:
    """Synthesize `text`. Returns (base64 WAV, model_used).

    The first element is None on total failure (both models unreachable, or
    neither returned audio) — the caller maps that to a 502, and the reply
    simply stays text-only. Never raises.
    """
    start = time.monotonic()
    clean = sanitize_for_speech(text)[:MAX_TEXT_CHARS]
    if not clean:
        return None, ""

    try:
        token = _get_credentials().token
    except Exception:
        logger.exception("speak: failed to obtain ADC token")
        return None, ""

    fell_back = False
    try:
        client = _get_client()
        resp = await _call_model(client, token, SPEAK_MODEL, clean)
        if resp.status_code in (404, 429, 503):
            fell_back = True
            resp = await _call_model(client, token, FALLBACK_MODEL, clean)
            model_used = FALLBACK_MODEL
        else:
            model_used = SPEAK_MODEL

        if resp.status_code != 200:
            logger.warning(
                "speak: %s returned %s: %s",
                model_used, resp.status_code, resp.text[:500],
            )
            return None, model_used

        pcm, sample_rate = _extract_audio(resp.json())
    except Exception:
        logger.exception("speak: request failed")
        return None, ""

    if not pcm:
        logger.warning("speak: %s returned no audio", model_used)
        return None, model_used

    wav_b64 = base64.b64encode(pcm_to_wav(pcm, sample_rate)).decode("ascii")
    logger.info(
        "speak: model=%s fell_back=%s chars_in=%d rate=%d pcm_bytes=%d duration_ms=%d",
        model_used, fell_back, len(clean), sample_rate, len(pcm),
        int((time.monotonic() - start) * 1000),
    )
    return wav_b64, model_used
