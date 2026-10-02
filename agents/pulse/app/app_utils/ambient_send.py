"""Pulse v2 email (spec 84): build and send the twice-weekly digest.

ONE email per run. Everything numeric is rendered here, deterministically,
from `get_visitor_stats`, `get_cost_summary` and `get_site_performance`; the
agent contributes only the TL;DR, its read on the conversations and
structured recommendations, which are rendered here too. The recipient is
always GAURAV_CONTACT_EMAIL (never an argument), and the Resend MCP path is
the one the chat agent uses, so no Resend credentials live here.

Email clients strip <style>, scripts and SVG, so the map, donuts and line
charts are PNGs from charts.py attached inline (Content-ID), and everything
else is an inline-styled table: stat cards, bars, the funnel and the heatmap
made of <td> widths and shades. A chart that fails falls back to HTML. Inline hex is required in email; the repo's CSS-variable rule
applies to the site, not transactional mail. Single 600px column, which
Gmail and Apple Mail shrink cleanly on a phone.
"""
from __future__ import annotations

import base64
import html as _htmllib
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from google.adk.tools import ToolContext
from pydantic import BaseModel

from app.app_utils import charts
from app.app_utils.ambient_data import (
    tokens_cost_usd,
    report_period,
    get_cost_summary,
    get_post_titles,
    get_site_performance,
    get_visitor_stats,
)
from app.app_utils.resume_send import _env, _send_via_mcp, record_send_failure

logger = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))

# Palette (inline hex, email clients can't use CSS variables). The header
# follows the site: black with the cyan accent.
_BG = "#f4f5f7"
_CARD = "#ffffff"
_INK = "#0b0f14"
_MUTED = "#6b7280"
_FAINT = "#9ca3af"
_LINE = "#e5e7eb"
_BRAND = "#00FFD1"
_GOOD = "#059669"
_BAD = "#dc2626"
_WARN = "#d97706"
_FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
_MONO = "'JetBrains Mono','SF Mono',Consolas,monospace"

MODES = [  # (key, label, colour)
    ("text", "Text", "#6366f1"),
    ("voice", "Voice", "#0ea5e9"),
    ("avatar", "Avatar", "#00b39a"),
    ("convo", "Live call", "#a855f7"),
]
PAGE_NAMES = {
    "/": "Home",
    "/ai-labs/": "AI Labs",
    "/ai-labs/mcp-lab/": "MCP Lab",
    "/ai-labs/engineering-loops/": "Engineering Loops",
    "/ai-labs/agent-ready/": "Agent-Ready Web",
    "/ai-labs/long-running-agents/": "Long-Running Agents",
    "/ai-labs/rag-lab/": "RAG Lab",
    "/live-agents/": "Live Agents",
}
SOURCE_NAMES = {"linkedin": "LinkedIn", "google": "Google", "direct": "Direct / unknown"}

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\n{3,}")


# ── small helpers ─────────────────────────────────────────────────────────────
def _html_to_text(html: str) -> str:
    """Plain-text fallback; the Resend MCP rejects a send without one."""
    text = re.sub(r"(?i)</(p|div|h[1-6]|ul|ol|blockquote|tr|table)>", "\n", html)
    text = re.sub(r"(?i)<li[^>]*>", "\n- ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = _TAG_RE.sub("", text)
    text = _htmllib.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = _WS_RE.sub("\n\n", text)
    return text.strip()


def _esc(s: Any) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _int(n: Any) -> int:
    try:
        return int(n or 0)
    except (TypeError, ValueError):
        return 0


def _num(n: Any) -> str:
    return f"{_int(n):,}"


def _money(amount: float, currency: str = "INR") -> str:
    sym = {"INR": "₹", "USD": "$", "EUR": "€"}.get(currency, currency + " ")
    if amount >= 100:
        return f"{sym}{amount:,.0f}"
    return f"{sym}{amount:,.2f}".rstrip("0").rstrip(".")


def _secs(ms: Any) -> str:
    return f"{_int(ms) / 1000:.1f}s" if ms else "n/a"


def _delta(curr: float, prev: float, good_when_up: bool = True) -> str:
    """'▲ 25%' / '▼ 10%' / 'new' / '' as a coloured inline span."""
    if not prev:
        return f'<span style="color:{_MUTED}">new</span>' if curr else ""
    pct = round((curr - prev) / prev * 100)
    if pct == 0:
        return f'<span style="color:{_MUTED}">flat</span>'
    up = pct > 0
    colour = _GOOD if up == good_when_up else _BAD
    return f'<span style="color:{colour}">{"▲" if up else "▼"} {abs(pct)}%</span>'


def _card(inner: str, pad: str = "18px 20px") -> str:
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:{_CARD};border:1px solid {_LINE};border-radius:12px;margin:0 0 14px">'
        f'<tr><td style="padding:{pad}">{inner}</td></tr></table>'
    )


def _ai_chip(model: str) -> str:
    """Marks a section written by Gemini; everything unmarked is computed."""
    return (f' <span style="display:inline-block;vertical-align:middle;font-size:10px;font-weight:600;'
            f'color:#6d28d9;background:#f3e8ff;border-radius:999px;padding:2px 8px;margin-left:6px">'
            f"✦ Powered by {_esc(model)}</span>")


def _section(title: str, body: str, note: str = "", ai: str = "") -> str:
    head = (
        f'<div style="font-size:17px;font-weight:700;color:{_INK};line-height:1.3;margin-bottom:12px">'
        f"{_esc(title)}{_ai_chip(ai) if ai else ''}"
        + (f'<div style="font-size:12px;font-weight:400;color:{_MUTED};margin-top:3px">{_esc(note)}</div>'
           if note else "")
        + "</div>"
    )
    return _card(head + body)


def _bar(parts: list[tuple[float, str]], height: int = 10) -> str:
    """A stacked horizontal bar from (share 0..1, colour) parts."""
    parts = [(w, c) for w, c in parts if w > 0]
    if not parts:
        return ""
    cells = "".join(
        f'<td width="{max(1, round(w * 100))}%" style="background:{c};height:{height}px;'
        f'font-size:0;line-height:0">&nbsp;</td>'
        for w, c in parts
    )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border-radius:6px;overflow:hidden;background:{_LINE}"><tr>{cells}</tr></table>'
    )


def _rows(rows: list[tuple[str, str]], first_width: str = "70%") -> str:
    out = "".join(
        f'<tr><td style="padding:7px 0;border-top:1px solid {_LINE};font-size:13px;color:{_INK};'
        f'width:{first_width}">{a}</td>'
        f'<td style="padding:7px 0 7px 10px;border-top:1px solid {_LINE};font-size:13px;color:{_MUTED};'
        f'text-align:right;white-space:nowrap">{b}</td></tr>'
        for a, b in rows
    )
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{out}</table>'


Images = list[tuple[str, bytes, str]]


def _img(images: Images | None, cid: str, png: bytes | None, alt: str) -> str:
    """Register an inline PNG and return its <img>, or "" when there's none
    (or when charts are off, images=None: every section falls back to HTML)."""
    if not png or images is None:
        return ""
    images.append((cid, png, alt))
    return (f'<img src="cid:{cid}" width="560" alt="{_esc(alt)}" '
            f'style="display:block;width:100%;max-width:560px;height:auto;border:0;margin:6px 0">')


# ── sections ──────────────────────────────────────────────────────────────────
def _modes_by_key(rows: list[dict[str, Any]] | None) -> dict[str, dict[str, Any]]:
    return {r.get("mode"): r for r in rows or []}


def avatar_minutes(stats: dict[str, Any], key: str = "modes") -> float:
    m = _modes_by_key(stats.get(key))
    secs = sum(float(m.get(k, {}).get("avatar_seconds") or 0) for k in ("avatar", "convo"))
    return round(secs / 60, 1)


def avatar_chats(stats: dict[str, Any]) -> int:
    m = _modes_by_key(stats.get("modes"))
    return sum(_int(m.get(k, {}).get("sessions")) for k in ("avatar", "convo"))


REPORT_NAME = "Gauravlahoti.dev Weekly Pulse"
REPORT_CADENCE = "Every Monday and Thursday, 08:00 IST"


def _d(dt: datetime, year: bool = False) -> str:
    return f"{dt.day} {dt:%b}" + (f" {dt.year}" if year else "")


def model_label(model_id: str) -> str:
    """'gemini-3.8-flash' -> 'Gemini 3.8 Flash'."""
    return " ".join(w.capitalize() for w in (model_id or "gemini").split("-"))


def run_usage(tool_context: Any) -> dict[str, Any]:
    """Tokens and estimated cost of this Pulse run so far: every Gemini call
    in the current invocation, from ADK's per-event usage metadata. Covers
    everything up to sending; only the final one-line reply comes after."""
    calls, tin, tout, thinking, models = 0, 0, 0, 0, []
    cost = 0.0
    try:
        session, inv = tool_context.session, tool_context.invocation_id
        for ev in session.events:
            um = getattr(ev, "usage_metadata", None)
            if not um or ev.invocation_id != inv:
                continue
            calls += 1
            i, o, t = (um.prompt_token_count or 0), (um.candidates_token_count or 0), (um.thoughts_token_count or 0)
            tin, tout, thinking = tin + i, tout + o, thinking + t
            model = getattr(ev, "model_version", None) or "gemini-3.8-flash"
            models.append(model)
            cost += tokens_cost_usd(model, i, o + t)
    except Exception:  # noqa: BLE001 - the email goes out without the tally
        logger.exception("could not read this run's usage")
        return {}
    if not calls:
        return {}
    model = max(set(models), key=models.count)
    return {"calls": calls, "tokens_in": tin, "tokens_out": tout, "thinking": thinking,
            "model": model, "cost_usd": round(cost, 4)}


def _when_ist(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, IST)


def period_of(stats: dict[str, Any], now: datetime) -> dict[str, datetime]:
    """The report period as IST datetimes: from the Worker's echo when there
    is one, else computed the same way Pulse asked for it."""
    p = stats.get("period") or {}
    if all(isinstance(p.get(k), (int, float)) for k in ("from", "to", "prev_from", "prev_to")):
        return {k: _when_ist(int(p[k])) for k in ("from", "to", "prev_from", "prev_to")}
    rp = report_period(now)
    return {k: _when_ist(rp[k]) for k in ("from", "to", "prev_from", "prev_to")}


def _span(a: datetime, b: datetime) -> str:
    days = (b - a).total_seconds() / 86400
    return f"{round(days)} days" if abs(days - round(days)) < 0.05 else f"{days:.1f} days"


def _header(now: datetime, period: dict[str, datetime]) -> str:
    """Report name and date, the period (since the last report) and what
    it's compared with (the same days a week earlier)."""
    f, t, pf, pt = period["from"], period["to"], period["prev_from"], period["prev_to"]
    label = (f'font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;'
             f'color:{_BRAND};padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap')
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:#000000;border-radius:14px;margin:0 0 14px">'
        f'<tr><td style="padding:22px 24px">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
        f'<td style="font-size:24px;font-weight:800;color:#ffffff;line-height:1.2">{REPORT_NAME}</td>'
        f'<td style="font-size:12px;color:#9ca3af;text-align:right;white-space:nowrap;vertical-align:top;'
        f'padding-top:6px">{now:%a} {_d(now, True)}</td></tr></table>'
        f'<div style="font-size:12px;color:#9ca3af;margin-top:2px">{REPORT_CADENCE}</div>'
        f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr>'
        f'<td style="{label}">Period</td>'
        f'<td style="font-size:13px;color:#ffffff;line-height:1.5">'
        f'<strong>{f:%a} {_d(f)} {f:%H:%M} to {t:%a} {_d(t)} {t:%H:%M}</strong>'
        f' <span style="color:#9ca3af">· since the last report, {_span(f, t)}</span></td></tr>'
        f'<tr><td style="{label}">Compared with</td>'
        f'<td style="font-size:13px;color:#9ca3af;line-height:1.5">the same days last week, '
        f"{_d(pf)} to {_d(pt)}</td></tr></table>"
        + "</td></tr></table>"
    )


def clean_tldr(items: Any) -> list[str]:
    """The agent's TL;DR bullets as plain text: up to three, one line each."""
    out = []
    for item in items if isinstance(items, list) else []:
        text = re.sub(r"\s+", " ", _TAG_RE.sub("", str(item or ""))).strip().lstrip("-•* ").strip()
        if text:
            out.append(text[:180])
    return out[:3]


def fallback_tldr(stats: dict[str, Any], cost: dict[str, Any], recs: list[dict[str, Any]]) -> list[str]:
    """Built from the numbers when the agent gave none, so the summary is
    never missing."""
    win, prev = stats.get("window") or {}, stats.get("prev_window") or {}
    visitors, before = _int(win.get("unique_visitors")), _int(prev.get("unique_visitors"))
    trend = f"{before} the same days last week"
    out = [f"{_plural(visitors, 'visitor')} ({trend}), {_plural(_int(win.get('conversations')), 'chat')} "
           f"with Atlas, {_plural(avatar_chats(stats), 'avatar chat')}."]
    if recs:
        out.append(f"Top action: {recs[0]['title']}.")
    st = {s.get("status"): _int(s.get("count")) for s in stats.get("statuses") or []}
    health = "no errors" if not st.get("error") else _plural(st["error"], "error")
    if cost.get("ok"):
        pace = "over" if cost.get("over_budget") else "within"
        out.append(f"Health: {health}. Spend {_money(cost['mtd'], cost['currency'])} so far, "
                   f"on pace for {_money(cost['forecast'], cost['currency'])}, {pace} budget.")
    else:
        out.append(f"Health: {health}.")
    return out


def _tldr(items: list[str], ai: str = "") -> str:
    if not items:
        return ""
    lis = "".join(
        f'<tr><td style="vertical-align:top;width:18px;padding:5px 0;color:#00b39a;font-weight:700">›</td>'
        f'<td style="padding:5px 0;font-size:14px;line-height:1.5;color:{_INK}">{_esc(t)}</td></tr>'
        for t in items
    )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:{_CARD};border:1px solid {_LINE};border-left:4px solid #00b39a;'
        f'border-radius:12px;margin:0 0 14px"><tr><td style="padding:14px 18px">'
        f'<div style="font-size:17px;font-weight:700;color:{_INK};line-height:1.3;margin-bottom:6px">'
        f"TL;DR{_ai_chip(ai) if ai else ''}</div>"
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{lis}</table>'
        f"</td></tr></table>"
    )


def _preheader(text: str) -> str:
    """Hidden first line: Gmail and Apple Mail show it as the inbox preview."""
    return (f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;'
            f'line-height:1px;color:{_BG}">{_esc(text)}</div>') if text else ""


def _kpi(value: str, label: str, sub: str) -> str:
    return (
        f'<td width="25%" valign="top" style="padding:0 4px">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:{_CARD};border:1px solid {_LINE};border-radius:12px">'
        f'<tr><td style="padding:14px 12px">'
        f'<div style="font-size:22px;font-weight:700;color:{_INK};line-height:1.1">{value}</div>'
        f'<div style="font-size:11px;color:{_MUTED};margin-top:6px">{_esc(label)}</div>'
        f'<div style="font-size:11px;margin-top:4px;min-height:14px">{sub}</div>'
        f"</td></tr></table></td>"
    )


def _kpis(stats: dict[str, Any], cost: dict[str, Any], images: Images) -> str:
    win, prev = stats.get("window") or {}, stats.get("prev_window") or {}
    mins, prev_mins = avatar_minutes(stats), avatar_minutes(stats, "prev_modes")
    if cost.get("ok"):
        colour = _BAD if cost.get("over_budget") else _MUTED
        spend = _kpi(
            _money(cost["mtd"], cost["currency"]), "Cloud spend",
            f'<span style="color:{colour}">{_money(cost["forecast"], cost["currency"])} by month end</span>',
        )
    else:
        spend = _kpi("n/a", "Cloud spend", f'<span style="color:{_MUTED}">no billing data</span>')
    cells = (
        _kpi(_num(win.get("unique_visitors")), "Visitors",
             _delta(_int(win.get("unique_visitors")), _int(prev.get("unique_visitors"))))
        + _kpi(_num(win.get("conversations")), "Chats with Atlas",
               _delta(_int(win.get("conversations")), _int(prev.get("conversations"))))
        + _kpi(f"{mins:g}", "Avatar minutes", _delta(mins, prev_mins))
        + spend
    )
    row = (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin:0 0 14px"><tr>{cells}</tr></table>'
    )
    daily = stats.get("daily") or []
    alt = "Visitors and chats with Atlas per day, last 14 days: " + ", ".join(
        f"{d['day'][5:]} {d.get('visitors', 0)}/{d.get('chats', 0)}" for d in daily)
    trend = _img(images, "trend", charts.trend(daily), alt)
    return row + (_section("Last 14 days", trend, "for context, beyond this period") if trend else "")


def _ttft_rows(m: dict[str, dict[str, Any]]) -> str:
    """TTFT per mode as bars, coloured against the 1.5s target."""
    rows = []
    vals = [(_int(m.get(k, {}).get("median_first_ms")), label, colour) for k, label, colour in MODES
            if m.get(k, {}).get("median_first_ms")]
    if not vals:
        return ""
    scale = max(3000, max(v for v, _, _ in vals))
    for ms, label, colour in vals:
        tone = _GOOD if ms <= 1500 else (_WARN if ms <= 3000 else _BAD)
        share = ms / scale
        rows.append((
            f'<span style="color:{colour}">●</span>&nbsp; {label}'
            f'<div style="margin-top:5px">{_bar([(share, tone), (1 - share, _LINE)], 6)}</div>',
            f'<span style="color:{tone};font-weight:600">{_secs(ms)}</span>',
        ))
    return (f'<div style="font-size:12px;color:{_MUTED};margin:12px 0 4px">TTFT, median time to first '
            f'token or spoken word · target 1.5s</div>' + _rows(rows))


def _how_they_talk(stats: dict[str, Any], images: Images) -> str:
    m = _modes_by_key(stats.get("modes"))
    total = sum(_int(r.get("turns")) for r in m.values())
    if not total:
        return ""
    chats = sum(_int(r.get("sessions")) for r in m.values())
    parts = [(label, _int(m.get(k, {}).get("sessions")), colour) for k, label, colour in MODES]
    alt = "Chats by mode: " + ", ".join(f"{l} {v}" for l, v, _ in parts if v)
    visual = _img(images, "modes", charts.donut(parts, _num(chats), "chats"), alt)
    if not visual:  # HTML fallback
        visual = _bar([(_int(m.get(k, {}).get("turns")) / total, c) for k, _, c in MODES])
    details = []
    for key, label, colour in MODES:
        r = m.get(key)
        if not r or not _int(r.get("turns")):
            continue
        detail = f"{_num(r.get('sessions'))} chats · {_num(r.get('turns'))} turns"
        if key in ("avatar", "convo") and r.get("avatar_seconds"):
            detail += f" · {float(r['avatar_seconds']) / 60:.1f} min spoken"
        details.append(f'<span style="color:{colour}">●</span> <strong>{label}</strong> '
                       f'<span style="color:{_MUTED}">{detail}</span>')
    statuses = {s.get("status"): _int(s.get("count")) for s in stats.get("statuses") or []}
    spoken = sum(_int(m.get(k, {}).get("turns")) for k in ("avatar", "convo"))
    note = ""
    if spoken and statuses.get("interrupted"):
        pct = round(statuses["interrupted"] / spoken * 100)
        note = (f'<div style="font-size:12px;color:{_MUTED};margin-top:10px">Visitors talked over '
                f"the avatar on {pct}% of spoken turns.</div>")
    body = (visual + f'<div style="font-size:12px;line-height:1.9;margin-top:6px">{"<br>".join(details)}</div>'
            + _ttft_rows(m) + note)
    return _section("How people talk to Atlas", body)


def _flag(iso: str) -> str:
    iso = (iso or "").upper()
    if len(iso) != 2 or not iso.isalpha():
        return ""
    return chr(0x1F1E6 + ord(iso[0]) - 65) + chr(0x1F1E6 + ord(iso[1]) - 65)


COUNTRY_NAMES = {"US": "US", "IN": "India", "GB": "UK", "DE": "Germany", "SG": "Singapore",
                 "CA": "Canada", "AE": "UAE", "AU": "Australia", "NL": "Netherlands", "FR": "France"}


def country_name(iso: Any) -> str:
    """Short name for an ISO code: our own short forms first, then the
    bundled Natural Earth names (so UG reads Uganda, not UG)."""
    iso = str(iso or "").upper()
    if iso in COUNTRY_NAMES:
        return COUNTRY_NAMES[iso]
    try:
        names = {f["properties"]["iso"]: f["properties"]["name"] for f in charts._world()["features"]}
        return names.get(iso) or iso
    except Exception:  # noqa: BLE001
        return iso


def _where(stats: dict[str, Any], images: Images) -> str:
    points = stats.get("geo_points") or []
    countries = stats.get("countries") or []
    if not (points or countries):
        return ""
    top = sorted(points, key=lambda p: -_int(p.get("visitors")))[:6]
    alt = "Visitor map for this period. Top cities: " + ", ".join(
        f"{p.get('city') or p.get('country')} {p.get('visitors')}" for p in top)
    body = _img(images, "map", charts.visitor_map(points), alt)
    total = sum(_int(c.get("visitors")) for c in countries)
    if total:
        shown = countries[:3]
        rest = total - sum(_int(c.get("visitors")) for c in shown)
        palette = [_INK, "#00b39a", "#64748b"]
        parts = [(_int(c.get("visitors")) / total, palette[i]) for i, c in enumerate(shown)]
        if rest > 0:
            parts.append((rest / total, _LINE))
        legend = " &nbsp; ".join(
            f'{_flag(c.get("country"))} {_esc(country_name(c.get("country")))} '
            f'<strong>{round(_int(c.get("visitors")) / total * 100)}%</strong>' for c in shown
        ) + (f' &nbsp; <span style="color:{_MUTED}">rest {round(rest / total * 100)}%</span>' if rest > 0 else "")
        body += (f'<div style="font-size:12px;color:{_MUTED};margin:12px 0 6px">Visitors by country</div>'
                 f'{_bar(parts, 10)}'
                 f'<div style="font-size:13px;color:{_INK};margin-top:8px">{legend}</div>')
    if not body:
        return ""
    return _section("Where visitors are", body)


def _heat(views: int, top: int) -> str:
    if not views:
        return "#f3f4f6"
    shades = ["#ccf5ee", "#80e6d6", "#33d1b8", "#00b39a", "#007d6b"]
    return shades[min(4, int(views / top * 4.999))]


def _when(stats: dict[str, Any]) -> str:
    hours = [_int(h) for h in (stats.get("hours") or [])]
    total = sum(hours)
    if len(hours) != 24 or not total:
        return ""
    top = max(hours)
    cells = "".join(
        f'<td title="{h:02d}:00 IST: {v}" style="background:{_heat(v, top)};height:26px;'
        f'border-right:2px solid #fff;font-size:0">&nbsp;</td>'
        for h, v in enumerate(hours)
    )
    ticks = "".join(
        f'<td colspan="6" style="font-size:10px;color:{_FAINT};padding-top:4px">{h:02d}:00</td>'
        for h in (0, 6, 12, 18)
    )
    # US daytime (09:00-19:00 ET) is about 19:30-05:30 IST; India's working day 09:00-19:00.
    us = sum(hours[h] for h in list(range(20, 24)) + list(range(0, 6)))
    india = sum(hours[h] for h in range(9, 19))
    peak = max(range(24), key=lambda h: hours[h])
    caption = (f"{round(india / total * 100)}% arrived in India's working day (09:00 to 19:00 IST), "
               f"{round(us / total * 100)}% in US daytime (20:00 to 06:00 IST). Busiest hour: {peak:02d}:00 IST.")
    body = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed">'
            f"<tr>{cells}</tr><tr>{ticks}</tr></table>"
            f'<div style="font-size:12px;color:{_MUTED};margin-top:8px">{caption}</div>')
    return _section("When they visit", body, "page views by hour of day, IST")


def _journey(stats: dict[str, Any]) -> str:
    f = stats.get("funnel") or {}
    sessions = _int(f.get("sessions"))
    if not sessions:
        return ""
    steps = [
        ("Visited the site", sessions, None),
        ("Chatted with Atlas", _int(f.get("chatted")), sessions),
        ("Used the avatar or a live call", _int(f.get("avatar")), _int(f.get("chatted"))),
        ("Asked for the resume or sent a note", _int(f.get("emailed")), _int(f.get("chatted"))),
    ]
    rows = []
    for label, n, of in steps:
        share = n / sessions
        conv = f' <span style="color:{_FAINT}">· {round(n / of * 100)}% of the step before</span>' if of else ""
        rows.append((
            f'{label}{conv}<div style="margin-top:5px">{_bar([(share, "#00b39a"), (1 - share, _LINE)], 8)}</div>',
            f"<strong style=\"color:{_INK}\">{_num(n)}</strong>",
        ))
    return _section("Journey", _rows(rows), "visits this period")


def _what_they_asked(stats: dict[str, Any], themes_html: str, ai: str = "") -> str:
    qs = [q for q in stats.get("top_questions") or [] if (q.get("question") or "").strip()][:5]
    rows = "".join(
        f'<tr><td style="padding:7px 0;border-top:1px solid {_LINE};font-size:13px;color:{_INK}">'
        f'{_esc(q["question"][:140])}</td>'
        f'<td style="padding:7px 0 7px 10px;border-top:1px solid {_LINE};font-size:12px;color:{_MUTED};'
        f'text-align:right;white-space:nowrap">'
        f'{"×" + str(_int(q.get("count"))) if _int(q.get("count")) > 1 else ""}</td></tr>'
        for q in qs
    )
    body = ""
    if rows:
        body += f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>'
    if themes_html:
        chip = (f'<div style="margin-top:14px">{_ai_chip(ai).strip()}</div>' if ai else "")
        body += chip + f'<div style="font-size:13px;line-height:1.6;color:{_INK};margin-top:8px">{themes_html}</div>'
    if not body:
        body = f'<div style="font-size:13px;color:{_MUTED}">A quiet stretch: nobody talked to Atlas.</div>'
    return _section("What they asked", body)


def _what_they_explored(stats: dict[str, Any]) -> str:
    pages = stats.get("top_pages") or []
    refs = stats.get("top_referrers") or []
    geo = stats.get("geo") or []
    if not (pages or refs):
        return ""
    body = ""
    if pages:
        top = max(_int(p.get("views")) for p in pages) or 1
        rows = []
        for p in pages[:6]:
            name = PAGE_NAMES.get(p.get("path"), p.get("path"))
            share = _int(p.get("views")) / top
            rows.append((
                f'{_esc(name)}<div style="margin-top:5px">{_bar([(share, _INK), (1 - share, _LINE)], 4)}</div>',
                f"{_num(p.get('views'))} views",
            ))
        body += _rows(rows)
    if refs:
        chips = " ".join(
            f'<span style="display:inline-block;border:1px solid {_LINE};border-radius:999px;'
            f'padding:4px 10px;margin:0 6px 6px 0;font-size:12px;color:{_INK}">'
            f'{_esc(SOURCE_NAMES.get(r.get("source"), r.get("source")))} '
            f'<span style="color:{_MUTED}">{_num(r.get("views"))}</span></span>'
            for r in refs
        )
        body += f'<div style="font-size:12px;color:{_MUTED};margin:14px 0 8px">Where they came from</div>{chips}'
    if geo:
        places = ", ".join(_esc(g.get("city") or g.get("country")) for g in geo[:4])
        body += f'<div style="font-size:12px;color:{_MUTED};margin-top:8px">Top locations: {places}</div>'
    return _section("What they explored", body)


def _plural(n: int, word: str) -> str:
    return f"{_num(n)} {word}{'' if n == 1 else 's'}"


def _reach(stats: dict[str, Any], titles: dict[str, str]) -> str:
    posts = stats.get("top_posts") or []
    emails = stats.get("emails") or {}
    body = ""
    if posts:
        rows = []
        for p in posts:
            title = titles.get(str(p.get("post_id")), "") or "LinkedIn post"
            rows.append((
                _esc(title[:90]),
                f"♥ {_num(p.get('reactions'))} · 💬 {_num(p.get('comments'))} · ↻ {_num(p.get('reposts'))}",
            ))
        body += _rows(rows, "62%")
    resumes, notes = _int(emails.get("resumes")), _int(emails.get("notes"))
    if resumes or notes:
        body += (f'<div style="font-size:13px;color:{_INK};margin-top:12px">Atlas emailed '
                 f'{_plural(resumes, "resume")} and passed on {_plural(notes, "note")} to you.</div>')
    return _section("Reach", body, "LinkedIn totals to date") if body else ""


def _site_speed(perf: dict[str, Any]) -> str:
    if not (perf or {}).get("ok") or perf.get("score") is None:
        return ""
    score = _int(perf["score"])
    tone = _GOOD if score >= 90 else (_WARN if score >= 50 else _BAD)
    m = perf.get("metrics") or {}
    bits = " · ".join(f"{k} {_esc(v)}" for k, v in (("LCP", m.get("lcp")), ("FCP", m.get("fcp")),
                                                     ("TBT", m.get("tbt")), ("CLS", m.get("cls"))) if v)
    return (f'<div style="font-size:13px;color:{_INK};margin-top:12px">Website speed (mobile Lighthouse): '
            f'<strong style="color:{tone}">{score}</strong> <span style="color:{_MUTED}">· {bits}</span></div>')


def _health(stats: dict[str, Any], perf: dict[str, Any] | None = None) -> str:
    st = {s.get("status"): _int(s.get("count")) for s in stats.get("statuses") or []}
    errors = st.get("error", 0)
    injection = st.get("injection", 0) + st.get("injection_blocked", 0)
    failures = _int((stats.get("emails") or {}).get("failures"))
    fb = stats.get("fallback") or {}
    fb_share = round(_int(fb.get("fell_back")) / _int(fb.get("turns")) * 100) if _int(fb.get("turns")) else 0
    info = []
    if st.get("scope_blocked"):
        info.append(f"{_plural(st['scope_blocked'], 'off-topic ask')} declined")
    if st.get("rate_limited"):
        info.append(f"{_plural(st['rate_limited'], 'visitor')} hit the daily limit")
    if st.get("too_long"):
        info.append(f"{_plural(st['too_long'], 'message')} too long")
    if fb_share:
        info.append(f"{fb_share}% of answers came from the fallback model")
    info_line = (f'<div style="font-size:12px;color:{_MUTED};margin-top:8px">{" · ".join(info)}</div>'
                 if info else "")
    speed = _site_speed(perf or {})
    if not (errors or injection or failures):
        return _section("Health", f'<div style="font-size:13px;color:{_GOOD};font-weight:600">'
                                  f"✓ All clear. No errors, failed emails or injection attempts.</div>"
                                  f"{info_line}{speed}")
    rows = []
    if errors:
        rows.append((f'<span style="color:{_BAD}">●</span>&nbsp; Turns that errored', _num(errors)))
    if failures:
        rows.append((f'<span style="color:{_BAD}">●</span>&nbsp; Emails that failed to send', _num(failures)))
    if injection:
        rows.append((f'<span style="color:{_WARN}">●</span>&nbsp; Prompt-injection attempts', _num(injection)))
    recent = [e for e in stats.get("errors") or [] if e.get("status") == "error"][:3]
    detail = "".join(
        f'<div style="font-size:12px;color:{_MUTED};margin-top:6px">“{_esc((e.get("question") or "")[:100])}” '
        f'<span style="font-family:{_MONO}">{_esc((e.get("error_message") or "")[:60])}</span></div>'
        for e in recent
    )
    return _section("Health", _rows(rows) + detail + info_line + speed)


FREE_TIER = "Cloudflare Worker + database, Resend email, GitHub Pages"
MODEL_PROJECT = "adk-deploy-trail"


def models_billed() -> bool:
    """Whether Gemini and avatar usage on adk-deploy-trail is actually
    charged. It runs on free credits today, so its list-price estimate is
    shown but kept out of the total. Set PULSE_MODELS_BILLED=1 when it bills."""
    return os.environ.get("PULSE_MODELS_BILLED", "0") == "1"


def spend_parts(cost: dict[str, Any], limit: int = 6) -> list[dict[str, Any]]:
    """The bill by service, with Cloud Run broken into its services
    ("Cloud Run: atlas") when the split is known; small parts fold into Other."""
    parts = []
    for s in cost.get("by_service") or cost.get("top_services") or []:
        if s["service"] == "Cloud Run" and cost.get("cloud_run_services"):
            parts += [{"service": f"Cloud Run: {r['service']}", "mtd": r["mtd"]} for r in cost["cloud_run_services"]]
        elif s["service"] != "Other":
            parts.append(dict(s))
    parts.sort(key=lambda p: -p["mtd"])
    total = sum(p["mtd"] for p in parts) or 1.0
    keep = [p for p in parts[:limit - 1] if p["mtd"] / total >= 0.01]   # slivers under 1% fold into Other
    rest = sum(p["mtd"] for p in parts if p not in keep) + sum(
        s["mtd"] for s in cost.get("by_service") or [] if s["service"] == "Other")
    out = keep
    if rest > 0:
        out.append({"service": "Other", "mtd": round(rest, 2)})
    return out


def cost_sources(cost: dict[str, Any], stats: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Where this month's money goes: (source, amount, basis). Infra is the
    real bill; Gemini + avatar is estimated from Atlas's usage, in the bill's
    currency at Google's own rate when the export provides it."""
    rows = []
    cur = cost.get("currency") or "INR"
    infra = cost.get("mtd") if cost.get("ok") else None
    rows.append(("Google Cloud infrastructure (Cloud Run, secrets, registry, scheduler)",
                 _money(infra, cur) if infra is not None else "not connected", "actual, from the bill"))
    usd = (stats.get("model_spend_usd") or {}).get("total")
    if usd is not None:
        rate = cost.get("usd_rate")
        amount = _money(usd * rate, cur) if rate else f"${usd:,.2f}"
        basis = ("estimate at list price, from Atlas usage" if models_billed() else
                 f"estimate at list price, from Atlas usage. {MODEL_PROJECT} runs on free credits "
                 f"today, so this isn't charged and isn't in the total")
        rows.append((f"Gemini and the avatar ({MODEL_PROJECT})", amount, basis))
    if infra is not None:
        billed_models = usd * cost["usd_rate"] if (models_billed() and usd is not None and cost.get("usd_rate")) else 0.0
        rows.append(("<strong>Total charged so far this month</strong>",
                     f"<strong>{_money(infra + billed_models, cur)}</strong>", ""))
    return rows


def _sources_table(rows: list[tuple[str, str, str]]) -> str:
    body = "".join(
        f'<tr><td style="padding:7px 0;border-top:1px solid {_LINE};font-size:13px;color:{_INK}">{name}'
        + (f'<div style="font-size:11px;color:{_FAINT};margin-top:2px">{basis}</div>' if basis else "")
        + f'</td><td style="padding:7px 0 7px 10px;border-top:1px solid {_LINE};font-size:13px;color:{_INK};'
        f'text-align:right;white-space:nowrap;vertical-align:top">{amount}</td></tr>'
        for name, amount, basis in rows
    )
    return (f'<div style="font-size:12px;color:{_MUTED};margin:14px 0 4px">Where the money goes</div>'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{body}</table>'
            f'<div style="font-size:11px;color:{_FAINT};margin-top:8px;line-height:1.5">Free tier, not in the '
            f"total: {FREE_TIER}. They cost nothing while usage stays within their free limits.</div>"
            f'<div style="font-size:11px;color:{_FAINT};margin-top:4px;line-height:1.5">Not counted yet: voice '
            f"transcription and speech, evaluation runs.</div>")


def _cost_watch(cost: dict[str, Any], images: Images, stats: dict[str, Any] | None = None) -> str:
    flagged = [s for s in (cost.get("always_on") or []) if not s.get("expected")]
    flag_html = "".join(
        f'<div style="font-size:13px;color:{_BAD};margin-top:10px">⚠ <strong>{_esc(s["service"])}</strong> '
        f'keeps {_plural(_int(s.get("min_instances")), "instance")} running all day. '
        f"If that isn't on purpose, set min-instances to 0.</div>"
        for s in flagged
    )
    if not cost.get("ok"):
        why = {
            "not_configured": "The billing export isn't connected yet.",
            "export_pending": ("The billing export is on. Google delivers the first data within about a "
                               "day, and real costs appear here from then."),
        }.get(cost.get("reason"), "Billing data couldn't be read this run.")
        return _section("Cost watch", f'<div style="font-size:13px;color:{_MUTED}">{why}</div>'
                        + _sources_table(cost_sources(cost, stats or {})) + flag_html)
    cur = cost["currency"]
    budget = float(cost.get("budget") or 0) or 1.0
    used = min(cost["mtd"] / budget, 1.0)
    fc_extra = max(0.0, min(cost["forecast"], budget) - cost["mtd"]) / budget
    pace_colour = _BAD if cost.get("over_budget") else _GOOD
    body = (
        f'<div style="font-size:13px;color:{_INK}">Google Cloud bill: <strong>{_money(cost["mtd"], cur)}</strong> '
        f'so far this month, <span style="color:{pace_colour}">on pace for {_money(cost["forecast"], cur)}</span> '
        f'<span style="color:{_MUTED}">against a {_money(budget, cur)} budget</span></div>'
        f'<div style="margin-top:10px">'
        f'{_bar([(used, _INK), (fc_extra, "#cbd5e1"), (max(0.0, 1 - used - fc_extra), _LINE)], 8)}</div>'
        f'<div style="font-size:11px;color:{_FAINT};margin-top:6px">dark: spent · grey: forecast to month '
        f"end · about {_money(cost.get('per_day') or 0, cur)} a day lately</div>"
    )
    sym = _money(0, cur)[0] if cur in ("INR", "USD", "EUR") else ""
    pace = _img(images, "pace", charts.spend_pace(cost.get("daily") or [], budget, cost["forecast"],
                                                 _int(cost.get("days_in_month")) or 30, sym),
                f"Spend so far {_money(cost['mtd'], cur)}, forecast {_money(cost['forecast'], cur)}, "
                f"budget {_money(budget, cur)}")
    shades = [_INK, "#334155", "#64748b", "#94a3b8", "#cbd5e1", "#e2e8f0"]
    services = spend_parts(cost)
    spend_donut = _img(images, "spend", charts.donut(
        [(s["service"], s["mtd"], shades[i % len(shades)]) for i, s in enumerate(services)],
        _money(cost["mtd"], cur), "this month", value_fmt=lambda v: _money(v, cur)),
        "Spend by service: " + ", ".join(f"{s['service']} {_money(s['mtd'], cur)}" for s in services))
    if cost.get("cloud_run_services"):
        spend_donut += (f'<div style="font-size:11px;color:{_FAINT};margin-top:2px">Cloud Run is one line on '
                        f"the bill, so it's split across services by each one's billable instance-hours "
                        f"this month.</div>")
    if pace or spend_donut:
        # The pace chart already shows spent vs forecast vs budget, so drop
        # the flat bar and its legend, keep the one-line summary.
        summary = body.split('<div style="margin-top:10px">', 1)[0]
        body = summary + pace + spend_donut
    elif cost.get("top_services"):
        body += '<div style="height:8px"></div>' + _rows(
            [(_esc(s["service"]), _money(s["mtd"], cur)) for s in cost["top_services"]]
        )
    body += _sources_table(cost_sources(cost, stats or {}))
    for mv in cost.get("movers") or []:
        what = "new this week" if mv.get("new") else f"up from {_money(mv['last_week'], cur)} the week before"
        body += (f'<div style="font-size:13px;color:{_WARN};margin-top:10px">▲ <strong>{_esc(mv["service"])}'
                 f"</strong> cost {_money(mv['this_week'], cur)} in the last 7 days, {what}.</div>")
    body += flag_html
    if cost.get("stale"):
        body += (f'<div style="font-size:12px;color:{_MUTED};margin-top:10px">The billing export looks '
                 f"more than 3 days behind, so these numbers may be low.</div>")
    if cost.get("month_start"):
        body += (f'<div style="font-size:12px;color:{_MUTED};margin-top:10px">New month: a good time to run '
                 f'<span style="font-family:{_MONO};color:{_INK}">/cost-optimizer</span> for a full scan.</div>')
    return _section("Cost watch", body)


class Recommendation(BaseModel):
    """One recommendation. Gives the model a typed schema (enums, required
    fields); ADK still passes plain dicts, which clean_recommendations checks."""

    area: Literal["agents", "website", "cost"]
    title: str
    problem: str
    action: str
    tangible: str
    intangible: str
    effort: Literal["S", "M", "L"]
    confidence: int


AREAS = {  # area -> (label, colour)
    "agents": ("Agents", "#6366f1"),
    "website": ("Website", "#0ea5e9"),
    "cost": ("Cost", "#d97706"),
}
EFFORT = {"S": "Small", "M": "Medium", "L": "Large"}


def clean_recommendations(recs: Any) -> list[dict[str, Any]]:
    """Validate the agent's structured recommendations. Text only (escaped at
    render), known areas, confidence clamped to 50..95, at most four."""
    out = []
    for r in recs if isinstance(recs, list) else []:
        if isinstance(r, BaseModel):
            r = r.model_dump()
        if not isinstance(r, dict):
            continue
        text = {k: _TAG_RE.sub("", str(r.get(k) or "")).strip()[:600]
                for k in ("title", "problem", "action", "tangible", "intangible")}
        if not (text["title"] and text["problem"] and text["action"]):
            continue
        area = str(r.get("area") or "").lower()
        try:
            conf = max(50, min(95, int(r.get("confidence") or 60)))
        except (TypeError, ValueError):
            conf = 60
        out.append({**text, "area": area if area in AREAS else "agents",
                    "effort": effort if (effort := str(r.get("effort") or "M").upper()[:1]) in EFFORT else "M",
                    "confidence": conf})
    return out[:4]


def _rec_card(i: int, r: dict[str, Any]) -> str:
    label, colour = AREAS[r["area"]]
    row = lambda k, v, strong=False: (  # noqa: E731
        f'<tr><td style="vertical-align:top;width:96px;padding:5px 10px 5px 0;font-size:10px;color:{_MUTED};'
        f'font-weight:600;letter-spacing:.6px;text-transform:uppercase">{k}</td>'
        f'<td style="padding:5px 0;font-size:13px;color:{_INK};line-height:1.55">'
        f'{"<strong>" if strong else ""}{_esc(v)}{"</strong>" if strong else ""}</td></tr>'
    ) if v else ""
    return (
        f'<div style="border-top:1px solid {_LINE};padding-top:14px;margin-top:{"0" if i == 0 else "16px"}">'
        f'<span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:.6px;'
        f'text-transform:uppercase;color:{colour};border:1px solid {colour};border-radius:999px;'
        f'padding:2px 8px">{label}</span>'
        f'<div style="font-size:15px;font-weight:700;color:{_INK};line-height:1.4;margin-top:8px">'
        f'{i + 1}. {_esc(r["title"])}</div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">'
        + row("Problem", r["problem"]) + row("Do this", r["action"])
        + row("Tangible", r["tangible"], True) + row("Intangible", r["intangible"])
        + "</table>"
        f'<div style="font-size:11px;color:{_FAINT};margin-top:6px">Effort {EFFORT[r["effort"]].lower()} · '
        f'confidence {r["confidence"]}%</div></div>'
    )


def _recommendations(recs: list[dict[str, Any]], ai: str = "") -> str:
    if not recs:
        return ""
    return _section("Recommendations", "".join(_rec_card(i, r) for i, r in enumerate(recs)),
                    "agents, website and cost, most valuable first", ai)


def _about(ai: str, usage: dict[str, Any], cost: dict[str, Any]) -> str:
    """What was AI-written, what wasn't, and what this report cost to write."""
    if not ai:
        return ""
    body = (
        f'<div style="font-size:13px;color:{_INK};line-height:1.6"><strong>{_esc(ai)}</strong> wrote the TL;DR, '
        f"the conversation themes and the recommendations, thinking at the high level.</div>"
        f'<div style="font-size:13px;color:{_INK};line-height:1.6;margin-top:6px">Everything else, every number, '
        f"chart, map and table, is computed straight from the site's data and Cloud Billing. No AI.</div>"
    )
    if usage:
        usd = usage["cost_usd"]
        rate = cost.get("usd_rate")
        local = f" ({_money(usd * rate, cost.get('currency') or 'INR')})" if rate else ""
        body += (
            f'<div style="font-size:12px;color:{_MUTED};margin-top:10px">This report: '
            f"{_plural(usage['calls'], 'model call')} · {_num(usage['tokens_in'])} input tokens · "
            f"{_num(usage['tokens_out'] + usage['thinking'])} output tokens, {_num(usage['thinking'])} of them thinking · "
            f"about ${usd:,.3f}{local} at {_esc(model_label(usage['model']))} list prices"
            + ("." if models_billed() else
               f", on {MODEL_PROJECT}'s free credits, so nothing is charged today.")
            + "</div>"
        )
    return _section("About this report", body)


def _footer() -> str:
    return (
        f'<div style="font-size:11px;color:{_FAINT};text-align:center;padding:6px 0 18px;line-height:1.6">'
        f"{REPORT_NAME} · {REPORT_CADENCE}</div>"
    )


def build_email(stats: dict[str, Any], cost: dict[str, Any], titles: dict[str, str],
                tldr: list[str] | None, themes_html: str,
                recommendations: list[dict[str, Any]] | None,
                perf: dict[str, Any] | None = None,
                now: datetime | None = None,
                usage: dict[str, Any] | None = None,
                charts_on: bool = True) -> tuple[str, Images]:
    """The email's HTML and the inline images it references (cid, png, alt).
    charts_on=False builds the image-free version (HTML bars and tables)."""
    stats, cost = stats or {}, cost or {}
    now = now or datetime.now(IST)
    images: Images | None = [] if charts_on else None
    recs = clean_recommendations(recommendations)
    usage = usage or {}
    # The label for AI-written parts: the model that actually answered.
    ai = model_label(usage["model"]) if usage.get("model") else ("Gemini 3.8 Flash" if (tldr or recs or themes_html) else "")
    agent_tldr = clean_tldr(tldr)
    summary = agent_tldr or fallback_tldr(stats, cost, recs)
    body = (
        _preheader(summary[0] if summary else "")
        + _header(now, period_of(stats, now))
        + _tldr(summary, ai if agent_tldr else "")
        + _kpis(stats, cost, images)
        + _how_they_talk(stats, images)
        + _where(stats, images)
        + _when(stats)
        + _journey(stats)
        + _what_they_asked(stats, themes_html, ai if themes_html else "")
        + _what_they_explored(stats)
        + _reach(stats, titles)
        + _health(stats, perf)
        + _cost_watch(cost, images, stats)
        + _recommendations(recs, ai)   # the evidence above, then what to do about it
        + _about(ai, usage, cost)
        + _footer()
    )
    html = (
        f'<div style="background:{_BG};padding:20px 0">'
        f'<div style="font-family:{_FONT};max-width:600px;margin:0 auto;padding:0 12px;color:{_INK}">'
        f"{body}</div></div>"
    )
    return html, images or []


async def _send_with_fallback(subject: str, build) -> dict[str, Any]:
    """Send with charts; if that fails, send the image-free version, so a
    problem carrying attachments (the MCP server's body limit, spec 84) never
    costs the whole email."""
    html, images = build(True)
    result = await _send_to_gaurav(subject=subject, html=html, images=images)
    if result.get("ok") or not images:
        return result
    logger.warning("digest send with charts failed (%s), retrying without them", result.get("code"))
    html, _ = build(False)
    retry = await _send_to_gaurav(subject=subject, html=html)
    if retry.get("ok"):
        retry = {**retry, "message": "Sent to Gaurav without charts."}
    return retry


def build_subject(stats: dict[str, Any], cost: dict[str, Any]) -> str:
    win = (stats or {}).get("window") or {}
    chats = avatar_chats(stats or {})
    parts = [_plural(_int(win.get("unique_visitors")), "visitor"), _plural(chats, "avatar chat")]
    if (cost or {}).get("ok"):
        parts.append(f"{_money(cost['mtd'], cost['currency'])} this month")
    return "Weekly Pulse · " + " · ".join(parts)


# ── sending ───────────────────────────────────────────────────────────────────
async def _send_to_gaurav(subject: str, html: str, images: Images | None = None) -> dict[str, Any]:
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
        "to": [to_addr],  # hardcoded recipient, never taken from model input
        "subject": subject,
        "html": html,
        "text": _html_to_text(html),  # Resend MCP requires a text part
    }
    if images:
        # Inline charts: the HTML references each as cid:<contentId>.
        arguments["attachments"] = [
            {"filename": f"{cid}.png", "content": base64.b64encode(png).decode("ascii"),
             "contentType": "image/png", "contentId": cid}
            for cid, png, _ in images
        ]
    mcp_start = time.monotonic()
    ok, _, attempts = await _send_via_mcp(arguments)
    if not ok:
        latency_ms = int((time.monotonic() - mcp_start) * 1000)
        # kind="digest": Pulse's own email, kept out of the site's Health count.
        await record_send_failure("digest", "send_failed", attempts=attempts, latency_ms=latency_ms)
        return {"ok": False, "code": "send_failed", "message": "The email couldn't be sent right now."}
    return {"ok": True, "code": "ok", "message": "Sent to Gaurav."}


async def send_numbers_only(note: str) -> dict[str, Any]:
    """The digest without the AI-written parts: every number, chart and the
    TL;DR built from the numbers, plus a one-line note saying why. Used when
    the agent ends a run without sending."""
    stats = await get_visitor_stats()
    cost = await get_cost_summary()
    perf = await get_site_performance()
    titles = await get_post_titles() if stats.get("top_posts") else {}
    banner = (f'<div style="font-size:12px;color:{_WARN};text-align:center;margin:0 0 10px">'
              f"{_esc(note)}</div>")

    def build(charts_on: bool):
        html, images = build_email(stats, cost, titles, [], "", [], perf, charts_on=charts_on)
        return html.replace(f'<div style="font-family:{_FONT};', banner + f'<div style="font-family:{_FONT};', 1), images

    return await _send_with_fallback(build_subject(stats, cost) + " · numbers only", build)


async def send_review_email(tldr: list[str], themes_html: str,
                            recommendations: list[Recommendation],
                            tool_context: ToolContext) -> dict[str, Any]:
    """Send the single digest email. Call it ONCE, at the end of the run.

    This tool fetches the stats, costs and site speed and renders every
    number and chart itself, so your arguments are words only.

    Args:
        tldr: Exactly three plain-text bullets, each under 25 words, that let
            Gaurav skip the rest of the email: (1) what happened with visitors
            and conversations, (2) the one thing that needs him, from your top
            recommendation, (3) health and spend in one line. Numbers only if
            they come from the tools. The first bullet is also the inbox
            preview.
        themes_html: Your read on the conversations, as plain HTML (<p>,
            <strong>, <ul><li>; no markdown, no code fences): the main themes
            and two or three standout questions.
        recommendations: Two to four objects, most valuable first, each with:
            area: "agents" | "website" | "cost"
            title: short imperative, what to do
            problem: what is wrong or missed today, citing the evidence
            action: the concrete change, specific enough to start on
            tangible: the measurable gain, with the number and how you got it
                (e.g. "about 900 rupees a month: the service runs one idle
                instance at roughly 30 a day")
            intangible: the softer gain (visitor experience, trust, Gaurav's
                time, reliability)
            effort: "S" | "M" | "L"
            confidence: integer 50 to 95
            Plain text in every field, no HTML.

    Returns:
        {ok: bool, code: str, message: str}. code: ok | not_configured | send_failed.
    """
    stats = await get_visitor_stats()
    cost = await get_cost_summary()
    perf = await get_site_performance()
    titles = await get_post_titles() if stats.get("top_posts") else {}
    usage = run_usage(tool_context)
    return await _send_with_fallback(
        build_subject(stats, cost),
        lambda charts_on: build_email(stats, cost, titles, tldr, themes_html, recommendations, perf,
                                      usage=usage, charts_on=charts_on),
    )
