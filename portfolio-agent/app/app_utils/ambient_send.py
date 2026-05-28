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
from datetime import datetime, timedelta, timezone
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


_GEO_COLORS = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6", "#ec4899", "#64748b"]

# Gemini 2.5 Flash pricing (USD per 1M tokens, non-thinking)
_PRICE_IN  = 0.15   # per 1M input tokens
_PRICE_OUT = 0.60   # per 1M output tokens

# Model names (keep in sync with agent.py / ambient_agent.py)
_MODEL_CHAT    = "gemini-2.5-flash"
_MODEL_AMBIENT = "gemini-2.5-flash"


def _delta_badge(curr: Any, prev: Any) -> str:
    """▲/▼ badge vs prior window. Always returns a span so card height stays consistent."""
    c, p = _int(curr), _int(prev)
    if p == 0:
        # No prior data — invisible placeholder preserves card height, no confusing label
        return f'<span style="color:transparent;font-size:12px">&nbsp;</span>'
    pct = round((c - p) / p * 100)
    if pct > 0:
        return f'<span style="color:{_GOOD};font-size:12px;font-weight:600">▲ {pct}%</span>'
    if pct < 0:
        return f'<span style="color:{_BAD};font-size:12px;font-weight:600">▼ {abs(pct)}%</span>'
    return f'<span style="color:{_MUTED};font-size:12px">— no change</span>'


def _stat_card(value: str, label: str, badge: str = "", width: str = "25%",
               accent: str = "", hero: bool = False) -> str:
    border = f"border-top:3px solid {accent};" if accent else ""
    num_size = "30px" if hero else "24px"
    bg = _SOFT
    return (
        f'<td width="{width}" style="padding:6px">'
        f'<div style="background:{bg};border-radius:10px;padding:14px 8px 12px;'
        f'text-align:center;{border}">'
        f'<div style="font-size:{num_size};font-weight:700;color:{_INK};line-height:1.1">{value}</div>'
        f'<div style="font-size:11px;color:{_MUTED};margin-top:5px;text-transform:uppercase;'
        f'letter-spacing:.4px">{label}</div>'
        f'<div style="min-height:18px;margin-top:4px">{badge}</div>'
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
        f'<div style="background:{_LINE};border-radius:4px;height:8px;width:100%">'
        f'<div style="background:{color};height:8px;border-radius:4px;width:{w}%"></div>'
        f"</div>"
    )


def _cards_row(cards: list[str]) -> str:
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border-collapse:separate"><tr>{"".join(cards)}</tr></table>'
    )


def _stacked_bar(items: list[tuple[str, int]]) -> str:
    """Horizontal stacked percentage bar — pure table HTML, works in all email clients."""
    total = sum(c for _, c in items) or 1
    cells = []
    for i, (_, count) in enumerate(items):
        pct = round(count / total * 100)
        if pct < 1:
            continue
        color = _GEO_COLORS[i % len(_GEO_COLORS)]
        radius = ""
        if i == 0:
            radius = "border-radius:6px 0 0 6px;"
        if i == len(items) - 1:
            radius += "border-radius:0 6px 6px 0;"
        cells.append(
            f'<td width="{pct}%" style="background:{color};height:14px;{radius}"></td>'
        )
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border-collapse:collapse;border-radius:6px;overflow:hidden">'
        f'<tr>{"".join(cells)}</tr></table>'
    )


def _fmt_k(n: Any) -> str:
    """Format large numbers as 1.2K, 45K, etc."""
    v = _int(n)
    if v >= 1_000_000:
        return f"{v/1_000_000:.1f}M"
    if v >= 10_000:
        return f"{v//1000}K"
    if v >= 1_000:
        return f"{v/1000:.1f}K"
    return str(v)


def _fmt_cost(tokens_in: Any, tokens_out: Any) -> str:
    cost = (_int(tokens_in) * _PRICE_IN + _int(tokens_out) * _PRICE_OUT) / 1_000_000
    if cost == 0:
        return "$0.00"
    if cost < 0.001:
        return f"${cost:.5f}"
    if cost < 0.01:
        return f"${cost:.4f}"
    if cost < 1:
        return f"${cost:.3f}"
    return f"${cost:.2f}"


def _fmt_date(dt: datetime) -> str:
    return dt.strftime("%d %b").lstrip("0")  # "26 May", "4 Jun"


def _token_row(tin: Any, tout: Any, tin_prev: Any = None, tout_prev: Any = None) -> str:
    """Compact 3-card row: tokens in, tokens out, estimated cost — embedded under stat rows."""
    cost_badge = ""
    if tin_prev is not None and tout_prev is not None:
        prev_cost_raw = (_int(tin_prev) * _PRICE_IN + _int(tout_prev) * _PRICE_OUT) / 1_000_000
        curr_cost_raw = (_int(tin) * _PRICE_IN + _int(tout) * _PRICE_OUT) / 1_000_000
        prev_micro = int(prev_cost_raw * 1_000_000)
        curr_micro = int(curr_cost_raw * 1_000_000)
        cost_badge = _delta_badge(curr_micro, prev_micro)
    return _cards_row([
        _stat_card(_fmt_k(tin),  "Tokens in",
                   _delta_badge(tin, tin_prev) if tin_prev is not None else "",
                   width="33%", accent="#94a3b8"),
        _stat_card(_fmt_k(tout), "Tokens out",
                   _delta_badge(tout, tout_prev) if tout_prev is not None else "",
                   width="34%", accent="#94a3b8"),
        _stat_card(_fmt_cost(tin, tout), "Est. cost (USD)",
                   cost_badge, width="33%", accent="#94a3b8"),
    ])



def _build_dashboard(stats: dict[str, Any]) -> str:
    """Render the deterministic metrics dashboard from a get_visitor_stats dict."""
    stats = stats or {}
    days = _int(stats.get("window_days")) or 4
    at = stats.get("all_time") or {}
    win = stats.get("window") or {}
    prev = stats.get("prev_window") or {}

    # ── Date ranges for headings ──────────────────────────────────────────────
    now_utc = datetime.now(timezone.utc)
    win_start  = now_utc - timedelta(days=days)
    prev_start = now_utc - timedelta(days=2 * days)
    window_label = f"{_fmt_date(win_start)} – {_fmt_date(now_utc)}"
    prev_label   = f"{_fmt_date(prev_start)} – {_fmt_date(win_start)}"

    # ── All-time strip + embedded token row ───────────────────────────────────
    all_time = _cards_row([
        _stat_card(_fmt_int(at.get("pageviews")),       "Pageviews",      width="20%", accent="#6366f1"),
        _stat_card(_fmt_int(at.get("unique_visitors")), "Visitors",       width="20%", accent="#06b6d4", hero=True),
        _stat_card(_fmt_int(at.get("downloads")),       "Downloads",      width="20%", accent="#10b981"),
        _stat_card(_fmt_int(at.get("conversations")),   "Conversations",  width="20%", accent="#f59e0b", hero=True),
        _stat_card(_fmt_int(at.get("unique_locations")), "Locations",     width="20%", accent="#8b5cf6"),
    ]) + _token_row(at.get("tokens_in"), at.get("tokens_out"))

    # ── This-window strip + embedded token row with deltas ────────────────────
    this_week = _cards_row([
        _stat_card(_fmt_int(win.get("unique_visitors")), "Visitors",
                   _delta_badge(win.get("unique_visitors"), prev.get("unique_visitors")),
                   width="20%", accent="#06b6d4", hero=True),
        _stat_card(_fmt_int(win.get("pageviews")), "Pageviews",
                   _delta_badge(win.get("pageviews"), prev.get("pageviews")),
                   width="20%", accent="#6366f1"),
        _stat_card(_fmt_int(win.get("downloads")), "Downloads",
                   _delta_badge(win.get("downloads"), prev.get("downloads")),
                   width="20%", accent="#10b981"),
        _stat_card(_fmt_int(win.get("conversations")), "Conversations",
                   _delta_badge(win.get("conversations"), prev.get("conversations")),
                   width="20%", accent="#f59e0b", hero=True),
        _stat_card(_fmt_int(win.get("unique_locations")), "Locations",
                   _delta_badge(win.get("unique_locations"), prev.get("unique_locations")),
                   width="20%", accent="#8b5cf6"),
    ]) + _token_row(
        win.get("tokens_in"), win.get("tokens_out"),
        prev.get("tokens_in"), prev.get("tokens_out"),
    )

    # ── Top questions (capped at 5 to keep email compact) ─────────────────────
    tq = (stats.get("top_questions") or [])[:5]
    if tq:
        top = max(_int(q.get("count")) for q in tq) or 1
        rows = []
        for i, q in enumerate(tq, 1):
            c = _int(q.get("count"))
            rows.append(
                f'<tr><td style="padding:6px 8px 6px 0;color:{_MUTED};font-size:12px;'
                f'vertical-align:top;width:16px;font-weight:600">{i}</td>'
                f'<td style="padding:6px 0;font-size:13px;color:{_INK}">'
                f'{_esc(str(q.get("question",""))[:100])}'
                f'<div style="margin-top:4px">{_bar(c / top * 100)}</div></td>'
                f'<td style="padding:6px 0 6px 10px;text-align:right;font-size:13px;'
                f'font-weight:700;color:{_ACCENT};vertical-align:top;width:28px">{c}</td></tr>'
            )
        questions = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            + "".join(rows) + "</table>"
        )
    else:
        questions = f'<p style="color:{_MUTED};font-size:13px">No questions this window.</p>'

    # ── Geo: stacked % bar + city breakdown ───────────────────────────────────
    geo = stats.get("geo") or []
    if geo:
        geo_items = [(
            ", ".join(p for p in (str(g.get("city") or "").strip(),
                                  str(g.get("country") or "").strip()) if p) or "Unknown",
            _int(g.get("count"))
        ) for g in geo]
        gtop = max(c for _, c in geo_items) or 1

        stack = _stacked_bar(geo_items)

        city_rows = []
        for i, (label, c) in enumerate(geo_items):
            color = _GEO_COLORS[i % len(_GEO_COLORS)]
            city_rows.append(
                f'<tr>'
                f'<td style="padding:5px 8px 5px 0;font-size:12px;color:{_INK};width:36%">'
                f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;'
                f'background:{color};margin-right:5px;vertical-align:middle"></span>'
                f'{_esc(label)}</td>'
                f'<td style="padding:5px 4px;width:52%">{_bar(c / gtop * 100, color)}</td>'
                f'<td style="padding:5px 0 5px 6px;text-align:right;font-size:12px;'
                f'font-weight:700;color:{_INK};width:12%">{c}</td>'
                f'</tr>'
            )
        city_table = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            + "".join(city_rows) + "</table>"
        )
        geo_html = stack + '<div style="margin-top:10px">' + city_table + "</div>"
    else:
        geo_html = f'<p style="color:{_MUTED};font-size:13px">No geo data yet.</p>'

    # ── Errors ────────────────────────────────────────────────────────────────
    errs = stats.get("errors") or []
    if errs:
        erows = [
            f'<tr style="background:#fef2f2">'
            f'<td style="padding:7px 8px;font-size:12px;color:{_INK};border:1px solid #fecaca">'
            f'{_esc(str(e.get("question",""))[:80])}</td>'
            f'<td style="padding:7px 8px;font-size:12px;color:{_BAD};border:1px solid #fecaca;'
            f'white-space:nowrap;width:90px">{_esc(e.get("status",""))}</td></tr>'
            for e in errs
        ]
        errors_html = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'style="border-collapse:collapse">'
            f'<tr><th align="left" style="padding:7px 8px;font-size:11px;color:{_MUTED};'
            'text-transform:uppercase;background:#f8fafc">Question</th>'
            f'<th align="left" style="padding:7px 8px;font-size:11px;color:{_MUTED};'
            'text-transform:uppercase;background:#f8fafc;width:90px">Status</th></tr>'
            + "".join(erows) + "</table>"
        )
    else:
        errors_html = (
            f'<p style="color:{_GOOD};font-size:13px;font-weight:600;margin:4px 0">'
            f'✓ No errors this window.</p>'
        )

    model_bar = (
        f'<div style="margin-top:10px;font-size:12px;color:#94a3b8">'
        f'Chat: <span style="color:#c7d2fe;font-weight:600">{_MODEL_CHAT}</span>'
        f'&nbsp;&nbsp;·&nbsp;&nbsp;'
        f'Digest: <span style="color:#c7d2fe;font-weight:600">{_MODEL_AMBIENT}</span>'
        f'&nbsp;&nbsp;·&nbsp;&nbsp;'
        f'Cost: ${_PRICE_IN}/1M in · ${_PRICE_OUT}/1M out'
        f'</div>'
    )

    return (
        f'<div style="background:{_INK};border-radius:12px;padding:20px 22px;color:#fff;margin-bottom:6px">'
        f'<div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Portfolio pulse</div>'
        f'<div style="font-size:22px;font-weight:700;margin-top:4px">Visitor intelligence digest</div>'
        f'<div style="font-size:13px;color:#cbd5e1;margin-top:6px">'
        f'This report: <strong style="color:#fff">{window_label}</strong>'
        f'&nbsp;&nbsp;·&nbsp;&nbsp;'
        f'Prior period: {prev_label}'
        f'</div>'
        + model_bar +
        f"</div>"
        + _section_title("All-time totals")
        + all_time
        + _section_title(f"Since last report &nbsp;<span style='font-size:13px;font-weight:400;color:{_MUTED}'>{window_label}</span>")
        + this_week
        + _section_title("Top questions")
        + questions
        + _section_title("Where visitors came from")
        + geo_html
        + _section_title("Errors &amp; no-response")
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
