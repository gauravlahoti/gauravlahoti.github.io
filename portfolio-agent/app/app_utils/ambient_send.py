"""Ambient-agent email — build and send the weekly visitor-intelligence digest.

ONE email per run (Spec #33): a deterministic HTML dashboard (real numbers,
tables, inline-CSS bar charts) computed from get_visitor_stats, followed by the
agent's qualitative insights and any lead follow-up drafts. The recipient is
always GAURAV_CONTACT_EMAIL (never an argument), and the Resend MCP path is the
same one the chat agent uses, so no Resend credentials live here.

Email clients strip <style>/JS and block external images, so every "chart" is
inline-styled HTML (stat cards, table rows, <div> bars whose width is a
percentage). Inline hex is required in email — the repo's CSS-variable rule
applies to the site, not transactional mail.
"""
from __future__ import annotations

import html as _htmllib
import logging
import re
from typing import Any

from app.app_utils.ambient_data import get_visitor_stats
from app.app_utils.resume_send import _env, _send_via_mcp

logger = logging.getLogger(__name__)

_SUBJECT = "Your weekly portfolio pulse is in"

# Palette (inline hex — email clients can't use CSS variables).
_INK = "#0f172a"
_MUTED = "#64748b"
_SOFT = "#f1f5f9"
_LINE = "#e2e8f0"
_ACCENT = "#6366f1"
_GOOD = "#16a34a"
_BAD = "#dc2626"

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\n{3,}")


# ── plain-text fallback (Resend MCP requires a text part) ────────────────────
def _html_to_text(html: str) -> str:
    """Derive a plain-text fallback from HTML so the Resend send is accepted."""
    text = re.sub(r"(?i)</(p|div|h[1-6]|ul|ol|blockquote|tr|table)>", "\n", html)
    text = re.sub(r"(?i)<li[^>]*>", "\n- ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = _TAG_RE.sub("", text)
    text = _htmllib.unescape(text)
    text = _WS_RE.sub("\n\n", text)
    return text.strip()


def _esc(s: Any) -> str:
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )


def _fmt_int(n: Any) -> str:
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return "0"


def _int(n: Any) -> int:
    try:
        return int(n or 0)
    except (TypeError, ValueError):
        return 0


def _delta_badge(curr: Any, prev: Any) -> str:
    """A small ▲/▼ percentage badge vs the prior window (or '' when n/a)."""
    c, p = _int(curr), _int(prev)
    if p == 0:
        return f' <span style="color:{_MUTED};font-size:12px">· new</span>' if c else ""
    pct = round((c - p) / p * 100)
    if pct > 0:
        return f' <span style="color:{_GOOD};font-size:12px;font-weight:600">▲ {pct}%</span>'
    if pct < 0:
        return f' <span style="color:{_BAD};font-size:12px;font-weight:600">▼ {abs(pct)}%</span>'
    return f' <span style="color:{_MUTED};font-size:12px">no change</span>'


def _stat_card(value: str, label: str, badge: str = "", width: str = "25%", accent: str = "") -> str:
    border = f"border-top:3px solid {accent};" if accent else ""
    return (
        f'<td width="{width}" style="padding:6px">'
        f'<div style="background:{_SOFT};border-radius:10px;padding:14px 8px;text-align:center;{border}">'
        f'<div style="font-size:24px;font-weight:700;color:{_INK};line-height:1.1">{value}</div>'
        f'<div style="font-size:11px;color:{_MUTED};margin-top:5px;text-transform:uppercase;'
        f'letter-spacing:.4px">{label}</div>'
        f'<div style="margin-top:4px">{badge}</div>'
        f"</div></td>"
    )


def _section_title(text: str) -> str:
    return (
        f'<h3 style="font-size:15px;color:{_INK};margin:26px 0 10px;'
        f'border-bottom:2px solid {_LINE};padding-bottom:6px">{_esc(text)}</h3>'
    )


def _bar(pct: float, color: str = _ACCENT) -> str:
    w = max(2, min(100, round(pct)))
    return (
        f'<div style="background:{_SOFT};border-radius:4px;height:8px;width:100%">'
        f'<div style="background:{color};height:8px;border-radius:4px;width:{w}%"></div>'
        f"</div>"
    )


def _cards_row(cards: list[str]) -> str:
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border-collapse:separate"><tr>{"".join(cards)}</tr></table>'
    )


_DONUT_COLORS = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6", "#ec4899", "#64748b"]


def _svg_donut(items: list[tuple[str, int]], size: int = 110) -> str:
    """Inline SVG donut chart. items = [(label, count), ...]. Works in Gmail/Apple Mail."""
    import math
    if not items:
        return ""
    total = sum(c for _, c in items) or 1
    R, cx, cy = 38, size // 2, size // 2
    circ = 2 * math.pi * R
    circles = []
    offset = 0.0
    # Background ring
    circles.append(
        f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="{_LINE}" stroke-width="14"/>'
    )
    for i, (_, count) in enumerate(items):
        dash = (count / total) * circ
        gap = circ - dash
        color = _DONUT_COLORS[i % len(_DONUT_COLORS)]
        circles.append(
            f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="{color}" '
            f'stroke-width="14" stroke-dasharray="{dash:.2f} {gap:.2f}" '
            f'stroke-dashoffset="-{offset:.2f}"/>'
        )
        offset += dash
    # Rotate so first segment starts at top
    return (
        f'<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}" '
        f'xmlns="http://www.w3.org/2000/svg">'
        f'<g transform="rotate(-90 {cx} {cy})">'
        + "".join(circles) +
        f'</g></svg>'
    )



def _build_dashboard(stats: dict[str, Any]) -> str:
    """Render the deterministic metrics dashboard from a get_visitor_stats dict."""
    stats = stats or {}
    days = _int(stats.get("window_days")) or 4
    at = stats.get("all_time") or {}
    win = stats.get("window") or {}
    prev = stats.get("prev_window") or {}

    # All-time strip ("since inception") — two rows of stat cards.
    all_time = _cards_row([
        _stat_card(_fmt_int(at.get("pageviews")), "Pageviews", width="20%", accent="#6366f1"),
        _stat_card(_fmt_int(at.get("unique_visitors")), "Visitors", width="20%", accent="#06b6d4"),
        _stat_card(_fmt_int(at.get("downloads")), "Downloads", width="20%", accent="#10b981"),
        _stat_card(_fmt_int(at.get("conversations")), "Conversations", width="20%", accent="#f59e0b"),
        _stat_card(_fmt_int(at.get("unique_locations")), "Locations", width="20%", accent="#8b5cf6"),
    ])

    # This-week strip with deltas vs the prior window.
    this_week = _cards_row([
        _stat_card(_fmt_int(win.get("unique_visitors")), "Visitors",
                   _delta_badge(win.get("unique_visitors"), prev.get("unique_visitors")),
                   width="20%", accent="#06b6d4"),
        _stat_card(_fmt_int(win.get("pageviews")), "Pageviews",
                   _delta_badge(win.get("pageviews"), prev.get("pageviews")),
                   width="20%", accent="#6366f1"),
        _stat_card(_fmt_int(win.get("downloads")), "Downloads",
                   _delta_badge(win.get("downloads"), prev.get("downloads")),
                   width="20%", accent="#10b981"),
        _stat_card(_fmt_int(win.get("conversations")), "Conversations",
                   _delta_badge(win.get("conversations"), prev.get("conversations")),
                   width="20%", accent="#f59e0b"),
        _stat_card(_fmt_int(win.get("unique_locations")), "Locations",
                   _delta_badge(win.get("unique_locations"), prev.get("unique_locations")),
                   width="20%", accent="#8b5cf6"),
    ])

    # Top questions with frequency bars.
    tq = stats.get("top_questions") or []
    if tq:
        top = max(_int(q.get("count")) for q in tq) or 1
        rows = []
        for i, q in enumerate(tq, 1):
            c = _int(q.get("count"))
            rows.append(
                f'<tr><td style="padding:7px 8px 7px 0;color:{_MUTED};font-size:13px;'
                f'vertical-align:top;width:18px">{i}</td>'
                f'<td style="padding:7px 0;font-size:13px;color:{_INK}">'
                f'{_esc(str(q.get("question",""))[:120])}'
                f'<div style="margin-top:5px">{_bar(c / top * 100)}</div></td>'
                f'<td style="padding:7px 0 7px 12px;text-align:right;font-size:13px;'
                f'font-weight:600;color:{_INK};vertical-align:top;width:34px">{c}</td></tr>'
            )
        questions = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            + "".join(rows) + "</table>"
        )
    else:
        questions = f'<p style="color:{_MUTED};font-size:13px">No questions asked in this window yet.</p>'

    # Geo: donut chart + bar table side-by-side.
    geo = stats.get("geo") or []
    if geo:
        gtop = max(_int(g.get("count")) for g in geo) or 1
        geo_total = sum(_int(g.get("count")) for g in geo)
        donut_items: list[tuple[str, int]] = []
        grows = []
        for i, g in enumerate(geo):
            c = _int(g.get("count"))
            city = str(g.get("city") or "").strip()
            country = str(g.get("country") or "").strip()
            label = ", ".join([p for p in (city, country) if p]) or "Unknown"
            color = _DONUT_COLORS[i % len(_DONUT_COLORS)]
            donut_items.append((label, c))
            grows.append(
                f'<tr><td style="padding:5px 10px 5px 0;font-size:12px;color:{_INK};'
                f'white-space:nowrap;width:42%">'
                f'<span style="display:inline-block;width:8px;height:8px;border-radius:2px;'
                f'background:{color};margin-right:5px;vertical-align:middle"></span>'
                f'{_esc(label)}</td>'
                f'<td style="padding:5px 0;width:42%">{_bar(c / gtop * 100, color)}</td>'
                f'<td style="padding:5px 0 5px 8px;text-align:right;font-size:12px;'
                f'font-weight:600;color:{_INK}">{c}</td></tr>'
            )
        donut_svg = _svg_donut(donut_items)
        bar_table = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            + "".join(grows) + "</table>"
        )
        geo_html = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            f'<tr><td width="120" style="vertical-align:top;padding-right:16px">'
            f'{donut_svg}</td>'
            f'<td style="vertical-align:top">{bar_table}</td></tr></table>'
        )
    else:
        geo_html = f'<p style="color:{_MUTED};font-size:13px">No geo data captured yet (analytics starts collecting from launch).</p>'

    # Errors / no-response scenarios.
    errs = stats.get("errors") or []
    if errs:
        erows = [
            '<tr style="background:#fef2f2">'
            f'<td style="padding:8px;font-size:12px;color:{_INK};border:1px solid #fecaca">'
            f'{_esc(str(e.get("question",""))[:90])}</td>'
            f'<td style="padding:8px;font-size:12px;color:{_BAD};border:1px solid #fecaca;'
            f'white-space:nowrap">{_esc(e.get("status",""))}</td></tr>'
            for e in errs
        ]
        errors_html = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'style="border-collapse:collapse">'
            f'<tr><th align="left" style="padding:8px;font-size:11px;color:{_MUTED};'
            'text-transform:uppercase">Question</th>'
            f'<th align="left" style="padding:8px;font-size:11px;color:{_MUTED};'
            'text-transform:uppercase">Status</th></tr>'
            + "".join(erows) + "</table>"
        )
    else:
        errors_html = (
            f'<p style="color:{_GOOD};font-size:13px;font-weight:600">'
            f'✓ No errors or empty responses this week.</p>'
        )

    return (
        f'<div style="background:{_INK};border-radius:12px;padding:20px 22px;color:#fff;margin-bottom:6px">'
        f'<div style="font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Portfolio pulse</div>'
        f'<div style="font-size:20px;font-weight:700;margin-top:4px">Visitor intelligence digest</div>'
        f'<div style="font-size:13px;color:#cbd5e1;margin-top:4px">Last {days} days vs the prior {days}</div>'
        f"</div>"
        + _section_title("All-time totals")
        + all_time
        + _section_title(f"This week (last {days} days)")
        + this_week
        + _section_title("Top questions")
        + questions
        + _section_title("Where visitors came from")
        + geo_html
        + _section_title("Errors & no-response")
        + errors_html
    )


def _shell(body: str) -> str:
    return (
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,'
        'Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#111;'
        'padding:8px">' + body + '</div>'
    )


async def _send_to_gaurav(subject: str, html: str) -> dict[str, Any]:
    sender = _env("NOTE_FROM_ADDRESS") or _env("RESEND_FROM_ADDRESS")
    to_addr = _env("GAURAV_CONTACT_EMAIL")
    mcp_url = _env("RESEND_MCP_URL")
    if not sender or not to_addr or not mcp_url:
        return {
            "ok": False,
            "code": "not_configured",
            "message": "Ambient email isn't configured on this environment.",
        }
    arguments = {
        "from": sender,
        "to": [to_addr],  # hardcoded recipient — never taken from model input
        "subject": subject,
        "html": html,
        "text": _html_to_text(html),  # Resend MCP requires a text part
    }
    ok, _ = await _send_via_mcp(arguments)
    if not ok:
        return {"ok": False, "code": "send_failed", "message": "The email couldn't be sent right now."}
    return {"ok": True, "code": "ok", "message": "Sent to Gaurav."}


async def send_review_email(insights_html: str, lead_drafts_html: str = "") -> dict[str, Any]:
    """Send the single weekly review email (dashboard + insights + lead drafts).

    Call this ONCE per run, after writing your qualitative insights and (if there
    are pending leads) the lead drafts. This tool fetches the visitor stats and
    renders the metrics dashboard itself, so you do NOT need to include numbers —
    focus your HTML on qualitative analysis and the per-lead outreach notes.

    Args:
        insights_html: Qualitative insights as plain HTML (use <strong>, <ul><li>,
            <p> — no markdown, no code fences): top themes, standout questions,
            gaps, and one improvement suggestion.
        lead_drafts_html: Optional. One outreach draft per pending lead as HTML
            (e.g. an <h4>Lead</h4> + <blockquote>draft</blockquote> each). Pass
            "" when there are no pending leads.

    Returns:
        {ok: bool, code: str, message: str}. code: ok | not_configured | send_failed.
    """
    stats = await get_visitor_stats(days=4)
    dashboard = _build_dashboard(stats)

    insights = (
        _section_title("Insights") + (insights_html or
        f'<p style="color:{_MUTED};font-size:13px">No notable themes this week.</p>')
    )

    drafts = ""
    if lead_drafts_html and lead_drafts_html.strip():
        drafts = (
            _section_title("Lead follow-up drafts")
            + f'<p style="color:{_MUTED};font-size:13px;margin-top:0">These visitors '
            "downloaded your resume and haven't been followed up. Edit and send as you see fit.</p>"
            + lead_drafts_html
        )

    body = _shell(dashboard + insights + drafts)
    return await _send_to_gaurav(subject=_SUBJECT, html=body)
