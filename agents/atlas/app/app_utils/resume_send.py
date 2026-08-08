"""Send-resume-by-email helpers for the portfolio agent.

Architecture:
  agent.send_resume(email)
    → validate format
    → POST /api/resume-send-check (Worker) → {allowed}
    → call MCP tool `send-email` on the resend-mcp-server (Streamable HTTP)
    → POST /api/resume-send-record (Worker) → row in resume_sends
    → return {ok, message}

The Resend API key lives ONLY on the resend-mcp-server (mounted via
Secret Manager). The portfolio agent has no Resend credentials — it
just speaks MCP to a trusted internal service. Recipient address is
hashed (sha256(email|UTC_DATE)[:16]) before any persistence.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from app import corpus_live

logger = logging.getLogger(__name__)

# RFC 5322-loose: enough to reject obvious typos, not strict enough to bounce
# valid edge cases. Resend will reject malformed addresses anyway.
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
_MAX_EMAIL_LEN = 200

_HTTP_TIMEOUT_S = 8.0
_MCP_TIMEOUT_S = 15.0  # MCP initialize + tool call may legitimately take a few seconds

# Retry budget for the MCP hop. The resend-mcp-server runs at min-instances=0, so
# a send can arrive while it is still cold. Its readiness gate makes Cloud Run
# queue the request rather than refuse it, but the queue wait can outlast a single
# attempt's timeout, so one transport failure is not evidence the send is
# impossible. Retries are bounded by a hard total budget because this runs inside
# a streaming chat turn — a visitor is waiting on it.
_MCP_MAX_ATTEMPTS = 3
_MCP_BACKOFF_S = (1.0, 4.0)  # sleep before attempts 2 and 3
_MCP_TOTAL_BUDGET_S = 32.0
_MCP_MIN_ATTEMPT_S = 3.0  # don't start an attempt that can't plausibly finish


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def hash_email(email: str) -> str:
    """sha256(email|UTC_DATE)[:16]. Daily-rotating salt, no manual rotation."""
    salt = datetime.now(UTC).strftime("%Y-%m-%d")
    return hashlib.sha256(f"{email.lower()}|{salt}".encode()).hexdigest()[:16]


def is_valid_email(email: str) -> bool:
    if not isinstance(email, str):
        return False
    e = email.strip()
    if not (3 <= len(e) <= _MAX_EMAIL_LEN):
        return False
    return bool(_EMAIL_RE.match(e))


def _check_url(path: str = "resume-send-check") -> str:
    base = _env("AGENT_LOG_URL")
    return base.replace("/api/agent-log", f"/api/{path}") if base else ""


def _record_url(path: str = "resume-send-record") -> str:
    base = _env("AGENT_LOG_URL")
    return base.replace("/api/agent-log", f"/api/{path}") if base else ""


async def _check_rate_limit(
    email_hash: str, token: str, *, path: str = "resume-send-check"
) -> tuple[bool, str | None, str | None]:
    """Ask the Worker whether this send is allowed.

    Returns (allowed, error, reason). `error` is set when the check itself could
    not be completed (fail closed). `reason` is the Worker's explanation for a
    denial — "global_cap" for the aggregate hourly ceiling across all recipients,
    "recipient_recent" for the per-address daily dedupe — so callers can say
    something true to the visitor instead of guessing.
    """
    url = _check_url(path)
    if not url or not token:
        # No Worker configured (local dev without backend) → permit but log.
        logger.info("%s skipped: AGENT_LOG_URL/TOKEN unset", path)
        return True, None, None
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
            r = await client.post(
                url,
                json={"emailHash": email_hash},
                headers={"X-Internal-Token": token, "Content-Type": "application/json"},
            )
        if r.status_code != 200:
            return False, f"check failed: {r.status_code}", None
        data = r.json()
        reason = data.get("reason")
        return bool(data.get("allowed", False)), None, (reason if isinstance(reason, str) else None)
    except Exception as exc:
        logger.warning("%s errored: %s", path, exc)
        return False, "check unavailable", None


async def _record_send(
    email_hash: str, token: str, *, path: str = "resume-send-record"
) -> None:
    url = _record_url(path)
    if not url or not token:
        return
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
            r = await client.post(
                url,
                json={"emailHash": email_hash},
                headers={"X-Internal-Token": token, "Content-Type": "application/json"},
            )
            if r.status_code >= 400:
                logger.warning("%s failed: %s %s", path, r.status_code, r.text[:200])
    except Exception as exc:
        logger.warning("%s errored: %s", path, exc)


# --- Branded resume email -----------------------------------------------------
#
# Design constraints (email is not the web — see the resume-email research):
#   * Table layout + fully inline styles. No <style> blocks, no CSS variables,
#     no flex/grid. Outlook renders with Word and drops all of it.
#   * Light body + a dark brand strip. A full-dark email gets aggressively and
#     unpredictably re-colored by Gmail/Outlook; a light body degrades cleanly.
#   * No images anywhere critical — remote images are blocked by default on
#     first contact, so the snapshot card is pure text (cyan diamond glyphs).
#   * Cyan (#00FFD1) is accent only (button fill, card rail, glyphs); it is far
#     too low-contrast to use as body text on white.
#   * Buttons carry a VML fallback so Outlook desktop still renders them.
#   * Voice: agent-forward, no em-dashes, no filler (repo voice rules).

_CYAN = "#00FFD1"
_DARK = "#0A0A0A"

# Curated 4 of Gaurav's strongest certs to feature (editorial pick, not the full
# list). Display labels are intentionally short so the card stays scannable.
_FEATURED_CERTS = [
    "Claude Certified Architect",
    "AWS ML Specialty",
    "GCP Generative AI Leader",
    "GCP Professional Security Engineer",
]

_FALLBACK_CTX = {
    "role": "Cloud & AI-Native Architect @ Deloitte",
    "location": "Gurugram, India",
    "linkedin": "https://www.linkedin.com/in/glahoti/",
    "topmate": "https://topmate.io/gaurav_lahoti25",
    "email": "gaurav.lahoti25@gmail.com",
}


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _resume_context() -> dict:
    """Pull role/location/links live from the profile, with a static fallback.

    Fetched inside try/except so a corpus-fetch blip never breaks the send path.
    Pulling links live also auto-fixes the Topmate handle (profile.json is the
    source of truth: gaurav_lahoti25, not the stale gaurav_lahoti).
    """
    ctx = dict(_FALLBACK_CTX)
    try:
        p = corpus_live.get_profile()
        links = p.get("links", {}) or {}
        title = (p.get("title") or "").strip()
        company = (p.get("company") or "").strip()
        if title and company:
            ctx["role"] = f"{title} @ {company}"
        ctx["location"] = (p.get("location") or ctx["location"]).strip()
        ctx["linkedin"] = links.get("linkedin") or ctx["linkedin"]
        ctx["topmate"] = links.get("topmate") or ctx["topmate"]
        ctx["email"] = links.get("email") or ctx["email"]
    except Exception as exc:
        logger.warning("resume email context fetch failed, using fallback: %s", exc)
    ctx["certs"] = list(_FEATURED_CERTS)
    return ctx


def _button(href: str, label: str, *, primary: bool, width: int = 260) -> str:
    """Bulletproof CTA button: VML for Outlook desktop, HTML anchor elsewhere."""
    href_e = _esc(href)
    label_e = f"{_esc(label)} &#8594;"
    if primary:
        vml_attrs = f'stroke="f" fillcolor="{_CYAN}"'
        vml_text = _DARK
        a_style = (
            f"background-color:{_CYAN};border-radius:6px;color:{_DARK};display:inline-block;"
            "font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;"
            "font-weight:600;line-height:46px;text-align:center;text-decoration:none;"
            f"width:{width}px;-webkit-text-size-adjust:none;mso-hide:all;"
        )
    else:
        vml_attrs = f'strokecolor="{_CYAN}" strokeweight="1.5px" fillcolor="#ffffff"'
        vml_text = _DARK
        a_style = (
            f"background-color:#ffffff;border:1.5px solid {_CYAN};border-radius:6px;color:{_DARK};"
            "display:inline-block;font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;"
            "font-size:15px;font-weight:600;line-height:43px;text-align:center;text-decoration:none;"
            f"width:{width}px;-webkit-text-size-adjust:none;mso-hide:all;"
        )
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;"><tr><td>'
        "<!--[if mso]>"
        '<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" '
        'xmlns:w="urn:schemas-microsoft-com:office:word" '
        f'href="{href_e}" style="height:46px;v-text-anchor:middle;width:{width}px;" '
        f'arcsize="12%" {vml_attrs}>'
        "<w:anchorlock/>"
        f'<center style="color:{vml_text};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">{label_e}</center>'
        "</v:roundrect>"
        "<![endif]-->"
        "<!--[if !mso]><!-- -->"
        f'<a href="{href_e}" style="{a_style}">{label_e}</a>'
        "<!--<![endif]-->"
        "</td></tr></table>"
    )


def _cert_rows(certs: list[str]) -> str:
    rows = []
    for i, name in enumerate(certs):
        pad = "0 0 6px" if i < len(certs) - 1 else "0"
        rows.append(
            "<tr>"
            f'<td width="18" valign="top" style="color:{_CYAN};font-size:14px;line-height:22px;'
            f'font-family:Arial,sans-serif;padding:{pad};">&#9670;</td>'
            '<td valign="top" style="font-family:Inter,-apple-system,\'Segoe UI\',Arial,sans-serif;'
            f'font-size:14px;line-height:22px;color:#333333;padding:{pad};">{_esc(name)}</td>'
            "</tr>"
        )
    return "".join(rows)


def _email_html(ctx: dict) -> str:
    mono = "'JetBrains Mono',Consolas,'SF Mono',monospace"
    sans = "Inter,-apple-system,'Segoe UI',Arial,sans-serif"
    role = _esc(ctx["role"])
    location = _esc(ctx["location"])

    return (
        "<!DOCTYPE html><html><head>"
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="light dark">'
        '<meta name="supported-color-schemes" content="light dark">'
        "</head>"
        '<body style="margin:0;padding:0;background:#F2F2F2;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F2F2;">'
        '<tr><td align="center" style="padding:24px 12px;">'

        # 600px shell
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" '
        'style="width:600px;max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;'
        'box-shadow:0 1px 3px rgba(0,0,0,0.08);">'

        # cyan signal rule
        f'<tr><td style="height:3px;background:{_CYAN};font-size:0;line-height:0;">&nbsp;</td></tr>'

        # dark brand strip
        f'<tr><td style="background:{_DARK};padding:28px 32px 26px;">'
        f'<p style="margin:0 0 14px;font-family:{mono};font-size:11px;letter-spacing:2px;'
        'text-transform:uppercase;color:#7A7A7A;">// RESUME &middot; DELIVERED</p>'
        f'<p style="margin:0;font-family:{sans};font-size:24px;line-height:28px;font-weight:700;'
        f'color:#FFFFFF;letter-spacing:0.5px;">GAURAV LAHOTI<span style="color:{_CYAN};">.</span></p>'
        f'<p style="margin:8px 0 0;font-family:{mono};font-size:13px;color:{_CYAN};">Cloud &amp; AI Architect</p>'
        "</td></tr>"

        # body copy
        '<tr><td style="padding:30px 32px 8px;">'
        f'<p style="margin:0 0 18px;font-family:{sans};font-size:20px;line-height:28px;font-weight:600;color:#111111;">'
        "Here&#39;s Gaurav Lahoti&#39;s resume, attached as a PDF.</p>"
        f'<p style="margin:0 0 16px;font-family:{sans};font-size:15px;line-height:24px;color:#555555;">'
        "I&#39;m Atlas, the agent that runs Gaurav&#39;s site. You asked for this, so I&#39;m getting it to you.</p>"
        f'<p style="margin:0 0 4px;font-family:{sans};font-size:15px;line-height:24px;color:#555555;">'
        "Quick context: Gaurav designs cloud and AI systems, the kind that have to hold up in production, "
        "not just in a demo. If that&#39;s close to what you&#39;re working on, he&#39;d genuinely like to hear about it.</p>"
        "</td></tr>"

        # snapshot card
        '<tr><td style="padding:16px 32px 8px;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="background:#FFFFFF;border:1px solid #E5E5E5;border-radius:8px;border-collapse:separate;">'
        "<tr>"
        f'<td width="4" style="background:{_CYAN};font-size:0;line-height:0;">&nbsp;</td>'
        '<td style="padding:20px 24px;">'
        # role row
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td width="74" valign="top" style="font-family:{mono};font-size:11px;letter-spacing:1px;'
        'color:#888888;padding:0 0 12px;">ROLE</td>'
        f'<td valign="top" style="font-family:{sans};font-size:15px;line-height:22px;color:#111111;padding:0 0 12px;">'
        f"{role}</td></tr>"
        '<tr><td width="74" valign="top" style="font-family:' + mono + ';font-size:11px;letter-spacing:1px;'
        'color:#888888;padding:0 0 12px;">BASED</td>'
        f'<td valign="top" style="font-family:{sans};font-size:15px;line-height:22px;color:#111111;padding:0 0 12px;">'
        f"{location}</td></tr></table>"
        # divider
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        '<td style="border-top:1px solid #EEEEEE;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>'
        # certs
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">'
        f"{_cert_rows(ctx['certs'])}</table>"
        "</td></tr></table></td></tr>"

        # CTA buttons
        '<tr><td style="padding:22px 32px 6px;">'
        + _button(ctx["topmate"], "Message Gaurav directly", primary=True)
        + _button(ctx["linkedin"], "Connect on LinkedIn", primary=False)
        + _button(f"mailto:{ctx['email']}?subject=Re%3A%20Your%20resume", "Email Gaurav", primary=False)
        + "</td></tr>"

        # opt-out line
        '<tr><td style="padding:6px 32px 24px;">'
        f'<p style="margin:0;font-family:{sans};font-size:14px;line-height:22px;color:#777777;">'
        "Didn&#39;t request this? Ignore it, nothing else will come your way.</p></td></tr>"

        # footer
        '<tr><td style="padding:0 32px 28px;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        '<td style="border-top:1px solid #E5E5E5;padding-top:16px;">'
        f'<p style="margin:0;font-family:{mono};font-size:12px;line-height:18px;color:#999999;">'
        "Atlas &middot; Gaurav&#39;s AI agent &middot; "
        '<a href="https://gauravlahoti.dev" style="color:#999999;text-decoration:underline;">gauravlahoti.dev</a>'
        "</p></td></tr></table></td></tr>"

        "</table></td></tr></table></body></html>"
    )


def _email_text(ctx: dict) -> str:
    return (
        "Here's Gaurav Lahoti's resume, attached as a PDF.\n\n"
        "I'm Atlas, the agent that runs Gaurav's site. You asked for this, so I'm getting it to you.\n\n"
        "Quick context: Gaurav designs cloud and AI systems, the kind that have to hold up in "
        "production, not just in a demo. If that's close to what you're working on, he'd genuinely "
        "like to hear about it.\n\n"
        f"Role: {ctx['role']}\n"
        f"Based: {ctx['location']}\n\n"
        "A few ways to reach him:\n"
        f"  Message Gaurav directly: {ctx['topmate']}\n"
        f"  Connect on LinkedIn: {ctx['linkedin']}\n"
        f"  Email Gaurav: {ctx['email']}\n\n"
        "Didn't request this? Ignore it, nothing else will come your way.\n\n"
        "Atlas · Gaurav's AI agent · gauravlahoti.dev\n"
    )


async def record_send_failure(kind: str, code: str, email_hash: str | None = None) -> None:
    """Persist a failed send to D1. Fire-and-forget; never raises.

    Complements the ERROR log: the log fires the alert, this row makes failures
    countable over time so the digest can report a trend instead of a one-off.
    """
    url = _record_url("send-fail")
    token = _env("AGENT_LOG_TOKEN")
    if not url or not token:
        return
    payload: dict[str, Any] = {"kind": kind, "code": code}
    if email_hash:
        payload["emailHash"] = email_hash
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
            r = await client.post(
                url,
                json=payload,
                headers={"X-Internal-Token": token, "Content-Type": "application/json"},
            )
            if r.status_code >= 400:
                logger.warning("send-fail record failed: %s %s", r.status_code, r.text[:200])
    except Exception as exc:
        logger.warning("send-fail record errored: %s", exc)


def _mcp_health_url() -> str:
    """Derive the MCP server's readiness URL from RESEND_MCP_URL (which ends in /mcp).

    Uses /readyz, not /healthz: on Cloud Run the exact path /healthz is
    intercepted by the Google Frontend and 404s without reaching the container,
    so it would never wake the service.
    """
    url = _env("RESEND_MCP_URL")
    if not url:
        return ""
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return ""
    return urlunsplit((parts.scheme, parts.netloc, "/readyz", "", ""))


async def warm_mcp_server(timeout_s: float = 3.0) -> bool:
    """Nudge the resend-mcp-server awake. Best effort, never raises.

    The service sits at min-instances=0 and takes several seconds to boot. Doing
    this when the chat widget opens means the server is usually already up by the
    time someone actually asks for the resume, so the send path rarely has to
    spend its retry budget waiting on a cold start.
    """
    url = _mcp_health_url()
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            r = await client.get(url)
        return r.status_code == 200
    except Exception as exc:
        # A cold instance may not answer within the timeout; that is fine, the
        # request still triggered the scale-up, which was the point.
        logger.info("MCP warm ping did not complete: %s", exc)
        return False


async def _attempt_send_via_mcp(
    mcp_url: str, mcp_headers: dict[str, str], arguments: dict[str, Any], timeout_s: float
) -> tuple[bool, str | None]:
    """One MCP `send-email` attempt.

    Returns (ok, error_message). Raises on transport failure so the caller can
    decide whether to retry; a tool-level rejection returns (False, msg) instead,
    because that is Resend refusing the message and retrying would not help.
    """
    async with streamablehttp_client(mcp_url, headers=mcp_headers, timeout=timeout_s) as (
        read,
        write,
        _,
    ):
        async with ClientSession(
            read, write, read_timeout_seconds=timedelta(seconds=timeout_s)
        ) as session:
            await session.initialize()
            result = await session.call_tool("send-email", arguments)
    if getattr(result, "isError", False):
        payload = getattr(result, "content", None)
        logger.error("EMAIL_SEND_FAILED MCP send-email rejected the message: %r", payload)
        return False, "MCP server returned error"
    return True, None


async def _send_via_mcp(arguments: dict[str, Any]) -> tuple[bool, str | None]:
    """Call the resend-mcp-server's `send-email` tool, retrying transport failures.

    Returns (ok, error_message). Retries cover the cold-start window on the MCP
    server; a tool-level rejection is returned immediately without retry, since
    re-sending could deliver the same email twice.
    """
    mcp_url = _env("RESEND_MCP_URL")
    if not mcp_url:
        logger.error("EMAIL_SEND_FAILED RESEND_MCP_URL not configured")
        return False, "RESEND_MCP_URL not configured"
    caller_token = _env("MCP_CALLER_TOKEN")
    mcp_headers = {"Authorization": f"Bearer {caller_token}"} if caller_token else {}

    deadline = time.monotonic() + _MCP_TOTAL_BUDGET_S
    last_exc: Exception | None = None

    for attempt in range(1, _MCP_MAX_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining < _MCP_MIN_ATTEMPT_S:
            break
        try:
            return await _attempt_send_via_mcp(
                mcp_url, mcp_headers, arguments, min(_MCP_TIMEOUT_S, remaining)
            )
        except Exception as exc:
            last_exc = exc
            # Intermediate attempts stay at WARNING on purpose: the alert policy
            # matches EMAIL_SEND_FAILED, and a transient that we then recover
            # from is not something to wake anyone up for.
            logger.warning(
                "MCP send-email attempt %d/%d failed: %s", attempt, _MCP_MAX_ATTEMPTS, exc
            )
            if attempt <= len(_MCP_BACKOFF_S):
                backoff = _MCP_BACKOFF_S[attempt - 1]
                if deadline - time.monotonic() > backoff + _MCP_MIN_ATTEMPT_S:
                    await asyncio.sleep(backoff)

    logger.error(
        "EMAIL_SEND_FAILED MCP send-email exhausted %d attempts in %.0fs budget: %s",
        _MCP_MAX_ATTEMPTS,
        _MCP_TOTAL_BUDGET_S,
        last_exc,
    )
    return False, "MCP transport error"


async def send_resume_email(email: str) -> dict[str, Any]:
    """Validate → rate-limit → send via MCP → record. Returns a result dict.

    Schema returned to the agent:
        {"ok": bool, "message": str, "code": "<short-code>"}

    Codes:
        invalid_email     — bad format, agent should ask for a valid one
        rate_limited      — already sent in the past 24h to this address
        not_configured    — server-side env vars missing (dev / misconfig)
        send_failed       — MCP / Resend rejected or transport error
        ok                — sent successfully
    """
    if not is_valid_email(email):
        return {"ok": False, "code": "invalid_email",
                "message": "That doesn't look like a valid email address. Could you double-check it?"}

    sender   = _env("RESEND_FROM_ADDRESS")
    pdf_url  = _env("RESUME_PDF_URL") or "https://gauravlahoti.dev/assets/img/resume.pdf"
    log_tok  = _env("AGENT_LOG_TOKEN")
    mcp_url  = _env("RESEND_MCP_URL")

    if not sender or not mcp_url:
        logger.error(
            "EMAIL_SEND_FAILED not configured (sender=%s mcp_url=%s)",
            bool(sender), bool(mcp_url),
        )
        return {"ok": False, "code": "not_configured",
                "message": "Email send isn't configured on this environment."}

    email_clean = email.strip()
    h = hash_email(email_clean)

    allowed, err, reason = await _check_rate_limit(h, log_tok)
    if not allowed:
        if err:
            logger.error("EMAIL_SEND_FAILED rate-limit service unreachable: %s", err)
            return {"ok": False, "code": "send_failed",
                    "message": "Couldn't reach the rate-limit service — try again in a minute."}
        if reason == "global_cap":
            # Aggregate ceiling across all recipients, not this address. Saying
            # "already went out to you" here would be plainly false.
            return {"ok": False, "code": "rate_limited",
                    "message": "I'm sending a lot of resumes right now, so this one is throttled. Try again shortly, or grab it straight from the site."}
        return {"ok": False, "code": "rate_limited",
                "message": "Looks like that resume already went out to that address today. Check your inbox (and spam folder)."}

    ctx = _resume_context()
    # BCC Gaurav on every send so he sees who requested the resume (a lead),
    # hidden from the recipient. Reply-To routes any reply to his inbox.
    gaurav_addr = _env("GAURAV_CONTACT_EMAIL") or ctx["email"]

    arguments = {
        "from": sender,
        "to": [email_clean],
        "subject": "Gaurav's resume, as promised",
        "html": _email_html(ctx),
        "text": _email_text(ctx),
        "attachments": [{
            "filename": "Gaurav_Lahoti_Cloud_AI_Architect.pdf",
            "url": pdf_url,
        }],
    }
    if gaurav_addr:
        arguments["bcc"] = [gaurav_addr]
        arguments["replyTo"] = [gaurav_addr]

    ok, mcp_err = await _send_via_mcp(arguments)
    if not ok:
        await record_send_failure("resume", "send_failed", h)
        return {"ok": False, "code": "send_failed",
                "message": "The email couldn't be sent right now. Try again, or reach Gaurav on LinkedIn."}

    await _record_send(h, log_tok)
    return {"ok": True, "code": "ok",
            "message": "Sent — should arrive in your inbox in a moment. Check the spam folder if it doesn't show up."}
