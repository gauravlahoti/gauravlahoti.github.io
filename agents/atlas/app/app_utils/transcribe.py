"""Speech-to-text for the Atlas voice-input mic button.

Ears only: this turns a short recorded clip into text for the composer. It is
not a conversation pipeline — there is no TTS here, and Atlas's replies stay
text-only. See `.claude/specs/48-atlas-voice-input.md`.

Primary model is `gemini-3.5-transcribe-preview`, a purpose-built STT model
with two switches a general reasoning model doesn't have: `mode: "SMART"`
strips filler words and self-corrections, and `customVocabulary` biases
recognition toward this site's proper nouns ("Deloitte", "Topmate", "ADK",
...). Both matter more than raw capability — Gemini Flash can transcribe
audio, but it decides what to keep as a byproduct of reasoning rather than as
a dedicated mode.

Note the `-preview` suffix: Google's public docs and the 2026-08-26 GA
announcement call it `gemini-3.5-transcribe`, but Vertex AI's actual Model
Garden publisher-model catalog for this project lists it as
`gemini-3.5-transcribe-preview` (confirmed via
`gcloud ai model-garden models list`) — the bare name 404s everywhere,
the `-preview` name works immediately in every location tried. Not an
access/allowlist issue; purely a naming mismatch between the docs and the
catalog ID, at least as of this project's rollout. Worth re-checking if a
future `gcloud` listing shows a bare `gemini-3.5-transcribe@default` entry.

The pinned `google-genai` (1.74.0) can't express `audioTranscriptionConfig` —
its `types.AudioTranscriptionConfig` is the *Live API's* config (only
`language_codes`), and `GenerateContentConfig` has no such field at all. So
this calls the Vertex REST endpoint directly with `httpx`, exactly like every
other helper in this package (`geo_lookup.py`, `resume_send.py`).
"""

from __future__ import annotations

import logging
import time
from typing import Any

import google.auth
import google.auth.transport.requests
import httpx

from app.fallback_model import ATLAS_VERTEX_LOCATION, ATLAS_VERTEX_PROJECT

logger = logging.getLogger(__name__)

TRANSCRIBE_MODEL = "gemini-3.5-transcribe-preview"
# Same model Atlas's chat already runs (app/agent.py) — reused here as the
# fallback so a transcription failure never depends on a *third* model being
# reachable. Not real SMART mode: the instruction below is a best-effort
# substitute for filler-word stripping if the primary ever becomes unreachable.
FALLBACK_MODEL = "gemini-3.7-flash"

_FALLBACK_INSTRUCTION = (
    "Transcribe the spoken audio. Return only the transcript text, nothing "
    "else — no preamble, no quotes, no commentary. Remove filler words "
    "(\"um\", \"uh\", \"like\") and false starts; keep the meaning intact."
)

# Static, not derived from corpus_live: these terms change maybe twice a
# year, and this call sits on the hot path of every voice tap, so it isn't
# worth a network round trip to keep it live.
CUSTOM_VOCABULARY = [
    "Gaurav Lahoti", "Deloitte", "Topmate", "Atlas", "Pulse",
    "Vertex AI", "Gemini", "ADK", "Agent Development Kit",
    "MCP", "Model Context Protocol", "Cloudflare", "Workers", "D1",
    "Cloud Run", "GKE", "BigQuery", "Terraform", "Kubernetes", "RAG",
    "WebMCP", "LinkedIn", "GCP", "Anthropic", "Claude", "FastAPI",
    "Firestore", "Pub/Sub",
]

# Browser MediaRecorder MIME → a type Gemini's audio input accepts. Strips
# any `;codecs=` parameter first. mp4 is remapped because the API's allowlist
# has `m4a`/`aac`, not `mp4`.
_MIME_ALLOWLIST = {
    "audio/webm": "audio/webm",
    "audio/mp4": "audio/m4a",
    "audio/m4a": "audio/m4a",
    "audio/ogg": "audio/ogg",
    "audio/wav": "audio/wav",
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
}

_TIMEOUT_S = 30.0

_creds: google.auth.credentials.Credentials | None = None
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Cached keep-alive client, reused across requests for this process's
    lifetime — the same rationale as `_get_credentials()`. Opening a fresh
    `httpx.AsyncClient` per call means a full TLS handshake to
    aiplatform.googleapis.com on every request; reusing one lets later
    requests skip it. Never explicitly closed: Cloud Run kills the container
    outright between cold starts rather than shutting it down gracefully, so
    there's no clean hook worth adding for a connection that dies with the
    process either way."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=_TIMEOUT_S)
    return _client


def normalize_mime(mime: str) -> str | None:
    """Return the Gemini-accepted MIME type for a browser-supplied one, or
    None if it isn't on the allowlist."""
    base = (mime or "").split(";", 1)[0].strip().lower()
    return _MIME_ALLOWLIST.get(base)


def _get_credentials() -> google.auth.credentials.Credentials:
    """Cached ADC credentials, refreshed in place — never rebuilt per call.

    Forces the same Vertex project/location Atlas's chat model uses
    (`fallback_model.py`), not the ambient `GEMINI_API_KEY` path, so this
    route can't inherit the AI Studio free-tier 503s/spend cap that chat
    was moved off of.
    """
    global _creds
    if _creds is None:
        _creds, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
    if not _creds.valid:
        _creds.refresh(google.auth.transport.requests.Request())
    return _creds


def warm() -> bool:
    """Prime the cached ADC credentials and httpx client.

    Mirrors speak.py's warm() for the same reason: the first Vertex call in a
    fresh container pays a token fetch plus a TLS handshake (spec 50 measured
    this class of tax at 5.57s cold vs 2.39s warm on the sibling TTS path).
    Voice input is mic-tap-gated and comparatively rare, so without this most
    real transcribe requests were each container's *first* transcribe call —
    paying the full cold tax every time, which is what showed up as "mobile
    transcription is slow" (voice input skews mobile-heavy by design; nothing
    in the request path itself differs by platform).
    """
    try:
        _get_credentials()
        _get_client()
        return True
    except Exception:
        logger.warning("transcribe: warm failed", exc_info=True)
        return False


def _model_url(model: str) -> str:
    return (
        f"https://aiplatform.googleapis.com/v1/projects/{ATLAS_VERTEX_PROJECT}"
        f"/locations/{ATLAS_VERTEX_LOCATION}/publishers/google/models/"
        f"{model}:generateContent"
    )


def _extract_text(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    parts = ((candidates[0] or {}).get("content") or {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()


async def _call_transcribe_model(
    client: httpx.AsyncClient, token: str, mime: str, audio_b64: str
) -> httpx.Response:
    return await client.post(
        _model_url(TRANSCRIBE_MODEL),
        headers={"Authorization": f"Bearer {token}"},
        json={
            "contents": [
                {
                    "role": "user",
                    "parts": [{"inlineData": {"mimeType": mime, "data": audio_b64}}],
                }
            ],
            "generationConfig": {
                "audioTranscriptionConfig": {
                    "mode": "SMART",
                    "customVocabulary": CUSTOM_VOCABULARY,
                    "languageCodes": [],
                }
            },
        },
    )


async def _call_fallback_model(
    client: httpx.AsyncClient, token: str, mime: str, audio_b64: str
) -> httpx.Response:
    return await client.post(
        _model_url(FALLBACK_MODEL),
        headers={"Authorization": f"Bearer {token}"},
        json={
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"inlineData": {"mimeType": mime, "data": audio_b64}},
                        {"text": _FALLBACK_INSTRUCTION},
                    ],
                }
            ],
        },
    )


async def transcribe_audio(audio_b64: str, mime: str) -> tuple[str | None, str]:
    """Transcribe base64-encoded audio. Returns (text, model_used).

    `text` is None on total failure (both models unreachable, or neither
    returned any speech) — the caller maps that to a 502. Never raises.
    """
    start = time.monotonic()
    try:
        token = _get_credentials().token
    except Exception:
        logger.exception("transcribe: failed to obtain ADC token")
        return None, ""

    fell_back = False
    try:
        client = _get_client()
        resp = await _call_transcribe_model(client, token, mime, audio_b64)
        if resp.status_code in (404, 429, 503):
            fell_back = True
            resp = await _call_fallback_model(client, token, mime, audio_b64)
            model_used = FALLBACK_MODEL
        else:
            model_used = TRANSCRIBE_MODEL

        if resp.status_code != 200:
            logger.warning(
                "transcribe: %s returned %s: %s",
                model_used, resp.status_code, resp.text[:500],
            )
            return None, model_used

        text = _extract_text(resp.json())
    except Exception:
        logger.exception("transcribe: request failed")
        return None, ""

    logger.info(
        "transcribe: model=%s fell_back=%s bytes_in=%d chars_out=%d duration_ms=%d",
        model_used, fell_back, len(audio_b64), len(text),
        int((time.monotonic() - start) * 1000),
    )
    return (text or None), model_used
