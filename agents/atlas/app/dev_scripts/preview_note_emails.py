"""Render both note emails (spec 111) to HTML files for a visual check.

    uv run python app/dev_scripts/preview_note_emails.py <out_dir> [--no-ai] [--send]

Uses the live corpus for the pick allowlist and, unless --no-ai, makes one
real Gemini call (ADC, adk-deploy-trail) on a sample chat, so the preview
shows Atlas's actual read. Writes briefing.html, receipt.html and the
fallback versions (no AI read). Sends nothing unless --send, which mails
both emails (with the AI read) to GAURAV_CONTACT_EMAIL only, subjects marked
[Preview] and Reply-To pointed at Gaurav, never at the sample visitor. Needs
RESEND_MCP_URL, MCP_CALLER_TOKEN, NOTE_FROM_ADDRESS, GAURAV_CONTACT_EMAIL.
"""

from __future__ import annotations

import asyncio
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from google.genai import types

from app.app_utils.conversation import plain_turns
from app.app_utils.note_brief import brief_note, build_allowlist
from app.app_utils.note_emails import (
    RECEIPT_SUBJECT, NoteEmail, briefing_html, briefing_subject, briefing_text, receipt_html, receipt_text,
)
from app.app_utils.resume_send import _env, _send_via_mcp

_CHAT = [
    ("user", "Has Gaurav worked on moving workloads from AWS to GCP?"),
    ("model", "Yes. At Deloitte he has led cloud migrations and designs landing zones on both AWS and GCP."),
    ("user", "How does his Atlas agent work? Is it built on ADK?"),
    ("model", "It is. Atlas runs on Google's Agent Development Kit on Cloud Run, with live retrieval tools."),
    ("user", "Can you show me how MCP works?"),
    ("model", "Sure, the MCP Lab walks through it in six acts. I've opened it for you."),
    ("user", "I'd like to send him a note"),
]
_NOTE = ("Hi Gaurav, I lead platform engineering at a fintech in Bengaluru. We're planning an AWS to GCP "
         "move next quarter and want agents in our ops workflows. Would love 30 minutes to compare notes.")


async def _send(n: NoteEmail) -> None:
    me, sender = _env("GAURAV_CONTACT_EMAIL"), _env("NOTE_FROM_ADDRESS")
    if not me or not sender or not _env("RESEND_MCP_URL"):
        raise SystemExit("--send needs GAURAV_CONTACT_EMAIL, NOTE_FROM_ADDRESS, RESEND_MCP_URL, MCP_CALLER_TOKEN")
    for subject, html, text in (
        (briefing_subject(n), briefing_html(n), briefing_text(n)),
        (RECEIPT_SUBJECT, receipt_html(n), receipt_text(n)),
    ):
        ok, err, attempts = await _send_via_mcp({
            "from": sender, "to": [me], "replyTo": [me],   # in prod the receipt goes to the visitor, BCC Gaurav
            "subject": f"[Preview] {subject}", "html": html, "text": text,
        })
        print(f"sent [Preview] {subject[:50]}: ok={ok} attempts={attempts} {err or ''}")


async def main(out: Path, use_ai: bool, send: bool = False) -> None:
    out.mkdir(parents=True, exist_ok=True)
    turns = [types.Content(role=r, parts=[types.Part.from_text(text=t)]) for r, t in _CHAT]
    allowlist = await build_allowlist()
    started = time.monotonic()
    brief = await brief_note(_NOTE, plain_turns(turns), allowlist) if use_ai else None
    print(f"allowlist: {len(allowlist)} pages; brief in {time.monotonic() - started:.1f}s: {brief}")
    now = datetime.now(UTC)
    ctx = {"referrer": "linkedin", "pages": ["/", "/live-agents/", "/ai-labs/mcp-lab/", "/selected-work/"],
           "city": "Bengaluru", "country": "IN", "first_seen": now.timestamp() - 14 * 60,
           "turns": 4, "modes": ["text", "avatar"]}
    for suffix, b in (("", brief), ("-fallback", None)):
        n = NoteEmail(visitor_email="priya.rao@example.com", message=_NOTE, sent_at=now, context=ctx,
                      brief=b, allowlist=allowlist, session_id="1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed")
        (out / f"briefing{suffix}.html").write_text(briefing_html(n))
        (out / f"receipt{suffix}.html").write_text(receipt_html(n))
        if not suffix and send:
            await _send(n)
        if not suffix:
            print("subject:", briefing_subject(n))
            print(briefing_text(n))
            print(receipt_text(n))
    print("wrote", out)


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]), "--no-ai" not in sys.argv, "--send" in sys.argv))
