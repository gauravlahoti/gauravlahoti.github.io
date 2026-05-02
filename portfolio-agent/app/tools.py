"""Portfolio retrieval tools.

Each function here is registered as an ADK tool. Functions are plain Python —
ADK derives the JSON schema from the type hints + docstring. All data is loaded
once at module import from `app/corpus/` (a frozen snapshot bundled into the
container at build time via `make corpus`).

No tool makes outbound HTTP. Every fact comes from the bundled corpus.
"""

from __future__ import annotations

import json
from pathlib import Path

_CORPUS_DIR = Path(__file__).parent / "corpus"


def _load_json(name: str) -> dict | list:
    return json.loads((_CORPUS_DIR / name).read_text(encoding="utf-8"))


_PROFILE: dict = _load_json("profile.json")  # type: ignore[assignment]
_GRAPH: dict = _load_json("graph.json")  # type: ignore[assignment]
_POSTS: list = _load_json("posts.json")  # type: ignore[assignment]
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
    return {
        "name": _PROFILE.get("name"),
        "title": _PROFILE.get("title"),
        "company": _PROFILE.get("company"),
        "location": _PROFILE.get("location"),
        "tagline": _PROFILE.get("tagline"),
        "bio": _PROFILE.get("bio", []),
        "careerStart": _PROFILE.get("careerStart"),
        "links": {
            "email": _PROFILE.get("links", {}).get("email"),
            "linkedin": _PROFILE.get("links", {}).get("linkedin"),
            "github": _PROFILE.get("links", {}).get("github"),
            "topmate": _PROFILE.get("links", {}).get("topmate"),
        },
        "capabilities": _PROFILE.get("capabilities", {}),
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
    flat: list[dict] = []
    for emp in _PROFILE.get("experience", []):
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
    nodes = {n["id"]: n for n in _GRAPH.get("nodes", [])}
    edges = _GRAPH.get("edges", [])

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
        for n in _GRAPH.get("nodes", [])
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
    return list(_POSTS[: max(1, min(limit, len(_POSTS)))])


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
        for c in _PROFILE.get("certifications", [])
    ]
