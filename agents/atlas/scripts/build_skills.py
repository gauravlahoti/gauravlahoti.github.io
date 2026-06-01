#!/usr/bin/env python3
"""Generate ADK skill directories from the bundled corpus snapshot.

Each corpus domain becomes one ADK skill under ``app/skills/<name>/SKILL.md``
(see Spec 37). The curated data is rendered *inline* in the SKILL.md body so a
single ``load_skill`` call grounds an answer — no second ``load_skill_resource``
round-trip. The curation reuses the exact transforms in ``app.tools``
(e.g. ``get_projects`` denormalizes graph nodes+edges), so skills stay faithful
to what the retrieval tools returned before.

Deterministic build: we force ``CORPUS_LIVE_OFF=1`` so the transforms read the
bundled ``app/corpus/*.json`` snapshot (synced by ``make corpus``) rather than
live-fetching the site. Run via ``make corpus`` before every deploy.

Usage:  uv run python scripts/build_skills.py
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

# Force bundled snapshot reads BEFORE importing app.tools (which imports
# corpus_live at module load and reads CORPUS_LIVE_OFF at import time).
os.environ["CORPUS_LIVE_OFF"] = "1"

from app import tools  # import after the env var set above

_SKILLS_DIR = Path(__file__).resolve().parent.parent / "app" / "skills"

# name (== directory == frontmatter name) -> (description, builder, usage line)
_SKILLS: list[tuple[str, str, callable, str]] = [
    (
        "gaurav-profile",
        "Gaurav's bio, headline, location, current focus, core capabilities, and public contact links.",
        lambda: tools.get_profile(),
        "Ground any question about who Gaurav is, his headline/title, location, bio, "
        "core capabilities, or how to reach him in the JSON below.",
    ),
    (
        "work-history",
        "Gaurav's roles and employers — titles, companies, dates, locations, and skills per role.",
        lambda: tools.get_work_history(),
        "Ground any question about where Gaurav has worked, his roles, tenure, or "
        "career timeline in the JSON below. `end: null` means the current role.",
    ),
    (
        "projects",
        "Notable projects Gaurav has shipped — architecture, outcomes, and the company, domains, and skills behind each.",
        lambda: tools.get_projects(),
        "Ground any question about what Gaurav has built or shipped in the JSON below. "
        "Each project already has its company, domains, and skills resolved.",
    ),
    (
        "recent-posts",
        "Gaurav's most recent LinkedIn posts — his public perspectives and what he's shipped lately.",
        lambda: tools.get_recent_posts(limit=100),
        "Ground any question about Gaurav's recent thinking, takes, or what he's been "
        "writing about in the JSON below. Posts are most-recent first; use each "
        "post's `url` field verbatim for citations.",
    ),
    (
        "certifications",
        "Gaurav's certifications, badges, and competition placements.",
        lambda: tools.get_certifications(),
        "Ground any question about Gaurav's certifications, badges, or competition "
        "wins/placements in the JSON below.",
    ),
]


def _render_skill_md(name: str, description: str, usage: str, data) -> str:
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    return (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        "---\n\n"
        f"# {name}\n\n"
        f"{usage}\n\n"
        "Treat this data as authoritative ground truth. Do not invent fields, "
        "URLs, projects, employers, or outcomes that are not present here.\n\n"
        "```json\n"
        f"{payload}\n"
        "```\n"
    )


def main() -> None:
    # Clean rebuild so removed corpus entries don't linger in stale skills.
    if _SKILLS_DIR.exists():
        shutil.rmtree(_SKILLS_DIR)
    _SKILLS_DIR.mkdir(parents=True)

    for name, description, builder, usage in _SKILLS:
        data = builder()
        body = _render_skill_md(name, description, usage, data)
        skill_dir = _SKILLS_DIR / name
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(body, encoding="utf-8")
        print(f"  built skill: {name} ({len(body)} bytes)")

    print(f"Wrote {len(_SKILLS)} skills to {_SKILLS_DIR}")


if __name__ == "__main__":
    main()
