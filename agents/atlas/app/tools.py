"""Portfolio retrieval + action tools.

Each function here is registered as an ADK tool. Functions are plain Python —
ADK derives the JSON schema from the type hints + docstring. Retrieval tools
read live data via `app.corpus_live`, which fetches the canonical JSON from
gauravlahoti.dev with a short TTL and falls back to the bundled snapshot in
`app/corpus/` if the network is unavailable. This means edits to the site's
`content/*.json` are reflected by the agent without a redeploy.

The retrieval tools make no outbound HTTP themselves beyond that data fetch.
The action tool (`send_resume`) talks to Resend's REST API and the
resume-gate Worker for rate-limit bookkeeping.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app import corpus_live
from app.app_utils.note_send import send_note_email
from app.app_utils.resume_send import send_resume_email

_CORPUS_DIR = Path(__file__).parent / "corpus"
_RESUME_MD: str = (_CORPUS_DIR / "resume.md").read_text(encoding="utf-8")


def get_profile() -> dict:
    """Return Gaurav Lahoti's identity, headline, bio, capability groups, and public links.

    Use this when the visitor asks who Gaurav is, what his headline is, where
    he's based, what his bio says, what his core capabilities are, or how to
    contact him.

    Returns:
        A dict with keys: name, title, company, location, tagline, bio (list of
        sentences), careerStart (YYYY-MM), links (email, linkedin, github,
        topmate, resume, resumeApi), capabilities (aiNative, cloud, business —
        each a list of capability groups with key/label/context/items).
    """
    profile = corpus_live.get_profile()
    return {
        "name": profile.get("name"),
        "title": profile.get("title"),
        "company": profile.get("company"),
        "location": profile.get("location"),
        "tagline": profile.get("tagline"),
        "bio": profile.get("bio", []),
        "careerStart": profile.get("careerStart"),
        "links": {
            "email": profile.get("links", {}).get("email"),
            "linkedin": profile.get("links", {}).get("linkedin"),
            "github": profile.get("links", {}).get("github"),
            "topmate": profile.get("links", {}).get("topmate"),
        },
        "capabilities": profile.get("capabilities", {}),
    }


def get_work_history(role_filter: str | None = None) -> list[dict]:
    """Return Gaurav's work history, optionally filtered by a substring match.

    The filter, if provided, matches case-insensitively against role title or
    company name (e.g., "manager", "deloitte", "gcp", "consultant").

    Args:
        role_filter: Optional substring. If None, return all roles.

    Returns:
        A flat list of role dicts. Each: {company, title, start, end, duration,
        location, skills, workMode}. `end` is None for the current role.
    """
    profile = corpus_live.get_profile()
    flat: list[dict] = []
    for emp in profile.get("experience", []):
        company = emp.get("company")
        work_mode = emp.get("workMode")
        for role in emp.get("roles", []):
            flat.append(
                {
                    "company": company,
                    "title": role.get("title"),
                    "start": role.get("start"),
                    "end": role.get("end"),
                    "duration": role.get("duration"),
                    "location": role.get("location"),
                    "skills": role.get("skills", []),
                    "workMode": work_mode,
                }
            )
    if role_filter is None:
        return flat
    needle = role_filter.lower()
    return [
        r
        for r in flat
        if needle in (r["title"] or "").lower()
        or needle in (r["company"] or "").lower()
        or any(needle in s.lower() for s in r["skills"])
    ]


def get_projects(domain: str | None = None) -> list[dict]:
    """Return notable projects Gaurav has shipped, optionally filtered by domain.

    Domains include "agentic-ai", "cloud-architecture", "enterprise-integration",
    "distributed-systems". The filter is case-insensitive substring match.

    Args:
        domain: Optional domain id or substring.

    Returns:
        A list of project dicts. Each: {id, label, description, year,
        company (resolved from edges), domains (list of domain labels), skills
        (list of skill labels)}.
    """
    graph = corpus_live.get_graph()
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    edges = graph.get("edges", [])

    project_company: dict[str, str] = {}
    project_domains: dict[str, list[str]] = {}
    project_skills: dict[str, list[str]] = {}
    for e in edges:
        src = e.get("source")
        tgt = e.get("target")
        src_n = nodes.get(src)
        tgt_n = nodes.get(tgt)
        if not src_n or not tgt_n:
            continue
        if src_n.get("type") == "project" and tgt_n.get("type") == "company":
            project_company[src] = tgt_n.get("label", tgt)
        if src_n.get("type") == "project" and tgt_n.get("type") == "domain":
            project_domains.setdefault(src, []).append(tgt_n.get("label", tgt))
        if src_n.get("type") == "project" and tgt_n.get("type") == "skill":
            project_skills.setdefault(src, []).append(tgt_n.get("label", tgt))

    projects = [
        {
            "id": n["id"],
            "label": n["label"],
            "description": n.get("description", ""),
            "year": n.get("year"),
            "company": project_company.get(n["id"]),
            "domains": project_domains.get(n["id"], []),
            "skills": project_skills.get(n["id"], []),
        }
        for n in graph.get("nodes", [])
        if n.get("type") == "project"
    ]

    if domain is None:
        return projects
    needle = domain.lower()
    return [
        p
        for p in projects
        if any(needle in d.lower() for d in p["domains"])
        or any(needle in s.lower() for s in p["skills"])
        or needle in p["label"].lower()
    ]


def get_recent_posts(limit: int = 5) -> list[dict]:
    """Return Gaurav's most recent LinkedIn posts (his public perspectives).

    Use this for questions about his recent thinking, his takes, what he's
    been writing about, or what he's shipped lately.

    Args:
        limit: Maximum number of posts to return. Default 5.

    Returns:
        A list of post dicts, most-recent first. Each: {url, firstLine,
        excerpt, date}.
    """
    posts = corpus_live.get_posts()
    return list(posts[: max(1, min(limit, len(posts)))])


async def send_resume(email: str) -> dict[str, Any]:
    """Email Gaurav's resume PDF to the visitor on explicit request.

    Call this tool ONLY when the visitor has clearly asked for the resume to
    be emailed AND has provided a destination address (e.g. "send the resume
    to me at name@company.com"). Do NOT call this for general "tell me about
    Gaurav" or resume-display intents — those should route to the on-site
    Resume button as described in the system instructions.

    The tool validates the email, enforces a 1-send-per-address-per-24h rate
    limit, and sends a single transactional email with the resume PDF
    attached. The visitor's address is hashed (with a daily-rotating salt)
    before any persistence — raw addresses are never stored.

    Args:
        email: The recipient address provided by the visitor.

    Returns:
        A dict {ok: bool, code: str, message: str}. Surface `message` in the
        visible reply. Codes:
            ok              — sent successfully.
            invalid_email   — ask the visitor for a valid address.
            rate_limited    — that address already received the resume today.
            not_configured  — env not set (dev / misconfig); apologize briefly.
            send_failed     — transient error; suggest LinkedIn as fallback.
    """
    return await send_resume_email(email)


async def send_note_to_gaurav(visitor_email: str, message: str) -> dict[str, Any]:
    """Send a personal note from a site visitor to Gaurav Lahoti by email.

    Call this tool ONLY when the visitor has BOTH composed a message AND
    provided their own email address. Do NOT call it with only a message or
    only an email — gather both before invoking.

    Gaurav receives the email at his contact inbox. The visitor is CC'd so
    they have a record. Reply-To is set to the visitor's address so Gaurav's
    reply goes directly to them without any extra steps.

    Args:
        visitor_email: The visitor's own email address (for CC receipt and
            Gaurav's reply-to).
        message: The visitor's message to Gaurav. Must be at least 10
            characters.

    Returns:
        A dict {ok: bool, code: str, message: str}. Always surface `message`
        in the visible reply. Codes:
            ok              — sent; confirm and optionally surface linkedin CTA.
            invalid_email   — ask the visitor for a valid address.
            empty_message   — ask for more content before retrying.
            not_configured  — env not set (dev / misconfig); route to LinkedIn.
            send_failed     — transient error; route to LinkedIn.
    """
    return await send_note_email(visitor_email, message)


def get_certifications() -> list[dict]:
    """Return all of Gaurav's certifications.

    Returns:
        A list of certification dicts, each: {name, issuer, category (ai /
        cloud / security), credlyUrl}.
    """
    return [
        {
            "name": c.get("name"),
            "issuer": c.get("issuer"),
            "category": c.get("category"),
            "credlyUrl": c.get("credlyUrl"),
        }
        for c in corpus_live.get_profile().get("certifications", [])
    ]


def get_live_agents() -> list[dict]:
    """Return the production AI agents Gaurav has built and deployed.

    Use this for questions about what agents Gaurav has shipped, the agents
    showcased on his site, or any specific one (Atlas, Pulse, ErrorLens,
    Agentic RAG). Each entry carries a `liveUrl` — the link to try that agent
    live, when one exists. Cite `liveUrl` verbatim.

    Returns:
        A list of agent dicts, each: {name, role, status, headline,
        description, value, stack, liveUrl}.
    """
    agents = corpus_live.get_agents()
    out = []
    for a in agents:
        # The live link is whichever link points off-site to a running demo,
        # not a same-page (#) or main-site (/) anchor.
        live_url = None
        for link in a.get("links", []):
            href = link.get("href", "")
            if href.startswith("http"):
                live_url = href
                break
        out.append({
            "name": a.get("name"),
            "role": a.get("role"),
            "status": a.get("status"),
            "headline": a.get("headline"),
            "description": a.get("description"),
            "value": a.get("value"),
            "stack": a.get("stack", []),
            "liveUrl": live_url,
        })
    return out
