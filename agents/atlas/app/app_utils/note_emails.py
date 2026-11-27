"""The two emails a visitor's note sends (spec 111).

1. A private briefing to Gaurav. Reply-To is the visitor. It carries the
   message as the hero, Atlas's read of the chat (next step plus what they
   asked about), and the session facts the Worker knows (arrival source,
   pages, place, mode, timing).
2. A confirmation to the visitor: their message quoted, plus 2-3 pages Atlas
   picked from what they talked about.

Same visual system as the resume email (resume_send._email_html): 600px
table shell, cyan rule, dark brand strip, mono eyebrows, bulletproof buttons.
Everything a visitor or the model wrote is escaped here; nothing in this
module trusts its inputs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

from app.app_utils.note_brief import DEFAULT_PICKS, Brief, Pick
from app.app_utils.resume_send import _CYAN, _DARK, _button, _esc

_SANS = "Inter,-apple-system,'Segoe UI',Arial,sans-serif"
_MONO = "'JetBrains Mono',Consolas,'SF Mono',monospace"
_INK = "#111111"
_BODY = "#444444"
_MUTED = "#888888"
_LINE = "#E5E5E5"
_SOFT = "#F7F7F7"
_AI_INK = "#6d28d9"
_AI_BG = "#f3e8ff"
_IST = timedelta(hours=5, minutes=30)

_MODES = {"text": "Typed chat", "voice": "Voice", "avatar": "Avatar video", "convo": "Hands-free voice"}
_SOURCES = {"linkedin": "LinkedIn", "google": "Google search", "direct": "Direct visit or a shared link"}
_COUNTRIES = {
    "IN": "India", "US": "United States", "GB": "United Kingdom", "SG": "Singapore", "AE": "UAE",
    "DE": "Germany", "CA": "Canada", "AU": "Australia", "NL": "Netherlands", "FR": "France",
    "IE": "Ireland", "JP": "Japan", "SA": "Saudi Arabia", "QA": "Qatar", "HK": "Hong Kong",
}
_PAGE_NAMES = {
    "/": "Home", "/live-agents/": "Live agents", "/ai-labs/": "AI Labs", "/insights/": "Insights",
    "/selected-work/": "Selected work",
}


@dataclass
class NoteEmail:
    visitor_email: str
    message: str
    sent_at: datetime
    context: dict[str, Any] | None = None       # GET /api/note-context, or None
    brief: Brief | None = None                  # note_brief.brief_note, or None
    allowlist: list[Pick] = field(default_factory=list)
    linkedin: str = "https://www.linkedin.com/in/glahoti/"
    topmate: str = "https://topmate.io/gaurav_lahoti25"
    session_id: str = ""


# ── small pieces ─────────────────────────────────────────────────────────────

def _flag(code: str) -> str:
    code = (code or "").upper()
    if len(code) != 2 or not code.isalpha():
        return ""
    return "".join(chr(0x1F1E6 + ord(c) - 65) for c in code)


def _place(ctx: dict[str, Any]) -> str:
    country = (ctx.get("country") or "").upper()
    parts = [p for p in (ctx.get("city"), _COUNTRIES.get(country, country)) if p]
    return (" ".join(filter(None, [", ".join(parts), _flag(country)]))).strip()


def _when(dt: datetime) -> str:
    ist = dt.astimezone(UTC) + _IST
    return ist.strftime("%a %d %b, %H:%M IST")


def _ago(first_seen: Any, sent_at: datetime) -> str:
    if not isinstance(first_seen, (int, float)):
        return ""
    mins = int((sent_at.timestamp() - first_seen) // 60)
    if mins < 1:
        return "under a minute after arriving"
    if mins < 90:
        return f"{mins} min after arriving"
    return f"{round(mins / 60)} h after arriving"


def page_name(path: str, allowlist: list[Pick]) -> str:
    """A visited path as a person would name it."""
    if path in _PAGE_NAMES:
        return _PAGE_NAMES[path]
    for p in allowlist:
        if p.url.endswith(path) and p.kind in ("Lab", "Insight"):
            return p.title
    tail = path.strip("/").split("/")[-1] if path.strip("/") else ""
    return tail.replace("-", " ").capitalize() or path


def _preheader(text: str) -> str:
    """The grey preview line inbox lists show after the subject."""
    return (f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">'
            f'{_esc(text)}{"&#847;&zwnj;&nbsp;" * 30}</div>')


def _shell(inner: str, preheader: str) -> str:
    return (
        "<!DOCTYPE html><html><head>"
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">'
        "</head>"
        '<body style="margin:0;padding:0;background:#F2F2F2;">'
        + _preheader(preheader)
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F2F2;">'
        '<tr><td align="center" style="padding:24px 12px;">'
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden;'
        'box-shadow:0 1px 3px rgba(0,0,0,0.08);">'
        f'<tr><td style="height:3px;background:{_CYAN};font-size:0;line-height:0;">&nbsp;</td></tr>'
        + inner
        + "</table></td></tr></table></body></html>"
    )


def _strip(eyebrow: str, title_html: str, sub: str) -> str:
    return (
        f'<tr><td style="background:{_DARK};padding:26px 32px 24px;">'
        f'<p style="margin:0 0 12px;font-family:{_MONO};font-size:11px;letter-spacing:2px;'
        f'text-transform:uppercase;color:#7A7A7A;">{eyebrow}</p>'
        f'<p style="margin:0;font-family:{_SANS};font-size:22px;line-height:28px;font-weight:700;color:#FFFFFF;">'
        f"{title_html}</p>"
        f'<p style="margin:8px 0 0;font-family:{_MONO};font-size:12px;line-height:18px;color:{_CYAN};">{sub}</p>'
        "</td></tr>"
    )


def _quote(message: str, size: int) -> str:
    body = _esc(message.strip()).replace("\n", "<br>")
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'style="border-collapse:separate;background:{_SOFT};border-radius:8px;"><tr>'
        f'<td width="4" style="background:{_CYAN};border-radius:8px 0 0 8px;font-size:0;line-height:0;">&nbsp;</td>'
        f'<td style="padding:18px 22px;font-family:{_SANS};font-size:{size}px;line-height:{int(size * 1.5)}px;'
        f'color:{_INK};">{body}</td></tr></table>'
    )


def _section_label(text: str) -> str:
    # No model name or AI badge on either email: the picks and the read should
    # feel like Atlas paying attention, not like a product label (Gaurav, spec 111).
    return (f'<p style="margin:0 0 12px;font-family:{_MONO};font-size:11px;letter-spacing:1.5px;'
            f'text-transform:uppercase;color:{_MUTED};">{text}</p>')


def _fact_rows(rows: list[tuple[str, str]]) -> str:
    out = []
    for i, (label, value) in enumerate(rows):
        border = f"border-top:1px solid {_LINE};" if i else ""
        out.append(
            "<tr>"
            f'<td width="96" valign="top" style="{border}padding:10px 0;font-family:{_MONO};font-size:11px;'
            f'letter-spacing:1px;text-transform:uppercase;color:{_MUTED};">{label}</td>'
            f'<td valign="top" style="{border}padding:10px 0;font-family:{_SANS};font-size:14px;line-height:21px;'
            f'color:{_INK};">{value}</td></tr>'
        )
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
            + "".join(out) + "</table>")


def _footer(text: str) -> str:
    return (
        '<tr><td style="padding:0 32px 26px;">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td style="border-top:1px solid {_LINE};padding-top:16px;font-family:{_MONO};font-size:12px;'
        f'line-height:18px;color:#999999;">{text}</td></tr></table></td></tr>'
    )


# ── 1. Gaurav's briefing ─────────────────────────────────────────────────────

def briefing_subject(n: NoteEmail) -> str:
    first = " ".join(n.message.split())
    first = first if len(first) <= 52 else first[:50].rsplit(" ", 1)[0] + "..."
    return f'Note from {n.visitor_email}: "{first}"'


def _read_block(n: NoteEmail) -> str:
    b = n.brief
    if b is None:
        return (_section_label("Atlas's read")
                + f'<p style="margin:0;font-family:{_SANS};font-size:14px;line-height:22px;color:{_MUTED};">'
                "Atlas couldn&#39;t summarise this chat. The facts below are still complete.</p>")
    html = _section_label("Atlas's read")
    if b.next_step:
        call = (f' <a href="{_esc(n.topmate)}" style="color:{_INK};font-weight:600;'
                f'text-decoration:underline;">Book a call &#8594;</a>') if b.suggest_call else ""
        html += (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            f'style="border-collapse:separate;background:{_AI_BG};border-radius:8px;margin:0 0 16px;"><tr>'
            f'<td style="padding:14px 18px;font-family:{_SANS};font-size:15px;line-height:23px;color:{_INK};">'
            f'<span style="font-family:{_MONO};font-size:10px;letter-spacing:1.5px;color:{_AI_INK};">'
            f"SUGGESTED NEXT STEP</span><br>{_esc(b.next_step)}{call}</td></tr></table>"
        )
    if b.asked_about:
        items = "".join(
            f'<tr><td width="18" valign="top" style="color:{_CYAN};font-size:12px;line-height:22px;'
            f'font-family:Arial,sans-serif;">&#9670;</td><td style="font-family:{_SANS};font-size:14px;'
            f'line-height:22px;color:{_BODY};padding:0 0 4px;">{_esc(a)}</td></tr>'
            for a in b.asked_about
        )
        html += (f'<p style="margin:0 0 8px;font-family:{_SANS};font-size:14px;font-weight:600;color:{_INK};">'
                 "Before writing, they asked Atlas about</p>"
                 f'<table role="presentation" cellpadding="0" cellspacing="0" border="0">{items}</table>')
    html += (f'<p style="margin:12px 0 0;font-family:{_SANS};font-size:12px;line-height:18px;color:{_MUTED};">'
             "An AI read of the chat. It can be wrong.</p>")
    return html


def _facts_block(n: NoteEmail) -> str:
    ctx = n.context or {}
    rows: list[tuple[str, str]] = []
    if ctx.get("referrer"):
        src = ctx["referrer"]
        rows.append(("Came from", _esc(_SOURCES.get(src, src))))
    pages = [page_name(p, n.allowlist) for p in (ctx.get("pages") or [])][:6]
    if pages:
        more = len(ctx.get("pages") or []) - len(pages)
        rows.append(("Viewed", " &#8594; ".join(_esc(p) for p in pages) + (f" +{more} more" if more > 0 else "")))
    modes = [_MODES.get(m, m) for m in (ctx.get("modes") or [])]
    if modes or ctx.get("turns"):
        turns = int(ctx.get("turns") or 0)
        q = f"{turns} message{'s' if turns != 1 else ''} to Atlas" if turns else ""
        rows.append(("Talked", _esc(", ".join(filter(None, [", ".join(modes), q])))))
    place = _place(ctx)
    if place:
        rows.append(("From", _esc(place)))
    ago = _ago(ctx.get("first_seen"), n.sent_at)
    rows.append(("Sent", _esc(", ".join(filter(None, [_when(n.sent_at), ago])))))
    return _section_label("Their visit") + _fact_rows(rows)


def briefing_html(n: NoteEmail) -> str:
    email = _esc(n.visitor_email)
    reply = f"mailto:{quote(n.visitor_email, safe='@')}?subject={quote('Re: your note on gauravlahoti.dev')}"
    inner = (
        _strip("// NOTE &middot; NEW", f'{email}<span style="color:{_CYAN};">.</span>',
               "wrote to you through Atlas")
        + '<tr><td style="padding:28px 32px 6px;">'
        + _section_label("Their message")
        + _quote(n.message, 18)
        + "</td></tr>"
        + '<tr><td style="padding:18px 32px 4px;">'
        + _button(reply, f"Reply to {n.visitor_email}" if len(n.visitor_email) <= 28 else "Reply to them",
                  primary=True, width=320)
        + f'<p style="margin:0;font-family:{_SANS};font-size:12px;line-height:18px;color:{_MUTED};">'
        "Or just hit Reply. It goes straight to them.</p>"
        "</td></tr>"
        + f'<tr><td style="padding:26px 32px 8px;">{_read_block(n)}</td></tr>'
        + f'<tr><td style="padding:22px 32px 24px;">{_facts_block(n)}</td></tr>'
        + _footer("Atlas &middot; your AI agent &middot; "
                  '<a href="https://gauravlahoti.dev" style="color:#999999;">gauravlahoti.dev</a>'
                  + (f" &middot; session {_esc(n.session_id[:8])}" if n.session_id else ""))
    )
    pre = n.brief.next_step if n.brief and n.brief.next_step else n.message
    return _shell(inner, pre[:140])


def briefing_text(n: NoteEmail) -> str:
    ctx = n.context or {}
    lines = [f"{n.visitor_email} wrote to you through Atlas:", "", n.message.strip(), "",
             "Reply to this email to answer them directly.", ""]
    if n.brief:
        if n.brief.next_step:
            lines += [f"Suggested next step: {n.brief.next_step}"]
            if n.brief.suggest_call:
                lines += [f"Book a call: {n.topmate}"]
        if n.brief.asked_about:
            lines += ["", "Before writing, they asked Atlas about:"] + [f"  - {a}" for a in n.brief.asked_about]
        lines += ["(An AI read of the chat. It can be wrong.)", ""]
    if ctx.get("referrer"):
        lines.append(f"Came from: {_SOURCES.get(ctx['referrer'], ctx['referrer'])}")
    if ctx.get("pages"):
        lines.append("Viewed: " + " > ".join(page_name(p, n.allowlist) for p in ctx["pages"][:6]))
    if _place(ctx):
        lines.append(f"From: {_place(ctx)}")
    lines.append(f"Sent: {_when(n.sent_at)}")
    return "\n".join(lines) + "\n\nAtlas, gauravlahoti.dev\n"


# ── 2. The visitor's confirmation ────────────────────────────────────────────

RECEIPT_SUBJECT = "Your note to Gaurav is on its way"


def receipt_picks(n: NoteEmail) -> list[tuple[Pick, str]]:
    if n.brief and len(n.brief.picks) >= 2:
        return n.brief.picks
    return [(p, p.blurb) for p in DEFAULT_PICKS]


def _pick_rows(picks: list[tuple[Pick, str]]) -> str:
    rows = []
    for i, (p, why) in enumerate(picks):
        border = f"border-top:1px solid {_LINE};" if i else ""
        rows.append(
            f'<tr><td style="{border}padding:14px 0;">'
            f'<p style="margin:0 0 2px;font-family:{_MONO};font-size:10px;letter-spacing:1.5px;'
            f'text-transform:uppercase;color:{_MUTED};">{_esc(p.kind)}</p>'
            f'<a href="{_esc(p.url)}" style="font-family:{_SANS};font-size:16px;line-height:24px;font-weight:600;'
            f'color:{_INK};text-decoration:none;">{_esc(p.title)} <span style="color:{_CYAN};">&#8594;</span></a>'
            + (f'<p style="margin:4px 0 0;font-family:{_SANS};font-size:14px;line-height:21px;color:{_BODY};">'
               f"{_esc(why)}</p>" if why else "")
            + "</td></tr>"
        )
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
            + "".join(rows) + "</table>")


def receipt_html(n: NoteEmail) -> str:
    personal = bool(n.brief and len(n.brief.picks) >= 2)
    inner = (
        _strip("// NOTE &middot; DELIVERED", f'Your note is with Gaurav<span style="color:{_CYAN};">.</span>',
               "Atlas &middot; Gaurav&#39;s AI agent")
        + '<tr><td style="padding:28px 32px 6px;">'
        f'<p style="margin:0 0 18px;font-family:{_SANS};font-size:16px;line-height:25px;color:{_BODY};">'
        "Thanks for writing. I passed this straight to Gaurav&#39;s inbox, and when he replies "
        "it comes from him, to this address.</p>"
        + _section_label("What you sent")
        + _quote(n.message, 15)
        + "</td></tr>"
        + '<tr><td style="padding:26px 32px 4px;">'
        + _section_label("While you wait")
        + (f'<p style="margin:0 0 4px;font-family:{_SANS};font-size:14px;line-height:21px;color:{_BODY};">'
           + ("Picked from what we talked about." if personal else "A few places to start.")
           + "</p>")
        + _pick_rows(receipt_picks(n))
        + "</td></tr>"
        + '<tr><td style="padding:18px 32px 6px;">'
        + _button(n.linkedin, "Connect on LinkedIn", primary=True)
        + _button(n.topmate, "Book a session with Gaurav", primary=False)
        + "</td></tr>"
        + '<tr><td style="padding:4px 32px 22px;">'
        f'<p style="margin:0;font-family:{_SANS};font-size:13px;line-height:20px;color:#777777;">'
        "Didn&#39;t send this? Someone typed your address on gauravlahoti.dev. "
        "Ignore it and nothing else will come your way.</p></td></tr>"
        + _footer("Atlas &middot; Gaurav&#39;s AI agent &middot; "
                  '<a href="https://gauravlahoti.dev" style="color:#999999;">gauravlahoti.dev</a>')
    )
    return _shell(inner, "Gaurav has your note. Here's what to explore while you wait.")


def receipt_text(n: NoteEmail) -> str:
    picks = "\n".join(f"  {p.title}: {p.url}" + (f"\n    {why}" if why else "") for p, why in receipt_picks(n))
    return (
        "Your note is with Gaurav.\n\n"
        "Thanks for writing. I passed this straight to Gaurav's inbox, and when he replies it comes "
        "from him, to this address.\n\n"
        f"What you sent:\n{n.message.strip()}\n\n"
        f"While you wait:\n{picks}\n\n"
        f"Connect on LinkedIn: {n.linkedin}\n"
        f"Book a session with Gaurav: {n.topmate}\n\n"
        "Didn't send this? Ignore it and nothing else will come your way.\n\n"
        "Atlas, Gaurav's AI agent, gauravlahoti.dev\n"
    )
