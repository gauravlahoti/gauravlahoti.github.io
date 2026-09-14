"""Unit tests for the build-story and AI-labs tools (spec #58).

Two things here are easy to get subtly wrong and invisible when they break:

1. The portfolio-path allowlist in `guardrails`. It replaced a deny-pattern
   that only caught `.pdf|/resume|/download|/file`, so anything else on
   gauravlahoti.dev sailed through. Widening it for `/ai-labs/` while it stays
   closed for invented paths is the whole point, and a regression either
   strips real lab links (visitor sees "(link removed)") or reopens the hole.

2. `get_ai_labs()` resolving site-relative hrefs to absolute URLs. If it emits
   a relative path, the model has to build the URL itself, which is exactly
   what the guardrail exists to prevent.
"""

from __future__ import annotations

import json

import pytest

from app import guardrails, tools


class TestPortfolioPathAllowlist:
    """`_strip_disallowed_urls` gates paths on the portfolio domain."""

    @pytest.mark.parametrize(
        "url",
        [
            "https://gauravlahoti.dev",
            "https://gauravlahoti.dev/",
            "https://gauravlahoti.dev/#insights",
            "https://gauravlahoti.dev/live-agents/",
            "https://gauravlahoti.dev/ai-labs/mcp-lab/",
            "https://gauravlahoti.dev/ai-labs/engineering-loops/",
            "https://gauravlahoti.dev/ai-labs/agent-ready/",
        ],
    )
    def test_allowed_paths_survive(self, url: str) -> None:
        text = f"Have a look at {url} when you get a moment."
        assert guardrails._strip_disallowed_urls(text) == text

    def test_invented_path_is_stripped(self) -> None:
        out = guardrails._strip_disallowed_urls(
            "Check https://gauravlahoti.dev/made-up-page here."
        )
        assert "made-up-page" not in out
        assert "(link removed)" in out

    @pytest.mark.parametrize(
        "url",
        [
            "https://gauravlahoti.dev/ai-labs-phishing/",
            "https://gauravlahoti.dev/live-agents-evil",
        ],
    )
    def test_lookalike_prefix_does_not_ride_in(self, url: str) -> None:
        # The allowlist matches whole path segments. A near-miss like
        # "/ai-labs-phishing" must not pass just because it starts with
        # "/ai-labs".
        out = guardrails._strip_disallowed_urls(f"Check {url} here.")
        assert "(link removed)" in out

    def test_resume_path_gets_the_button_hint(self) -> None:
        out = guardrails._strip_disallowed_urls(
            "Grab https://gauravlahoti.dev/resume.pdf now."
        )
        assert "resume.pdf" not in out
        assert "click the Resume button" in out

    def test_rag_subdomain_is_untouched(self) -> None:
        # agentic-rag.gauravlahoti.dev is a separate allowed host, not a path
        # on the portfolio domain. The path gate must not see it at all.
        text = "The RAG Lab is live at https://agentic-rag.gauravlahoti.dev/ today."
        assert guardrails._strip_disallowed_urls(text) == text

    def test_offsite_url_still_stripped(self) -> None:
        out = guardrails._strip_disallowed_urls("Go to https://example.com/bad here.")
        assert "(link removed)" in out

    def test_url_at_chunk_end_is_left_alone(self) -> None:
        # after_model_callback runs per streamed chunk. A URL flush against the
        # end may still be arriving, so a half-written /ai-labs/ path must not
        # be judged on its prefix and stripped.
        text = "Try https://gauravlahoti.dev/ai-la"
        assert guardrails._strip_disallowed_urls(text) == text


class TestGetAiLabs:
    @pytest.mark.asyncio
    async def test_resolves_hrefs_to_absolute_urls(self) -> None:
        labs = await tools.get_ai_labs()
        assert labs, "expected at least one lab in ai-concepts.json"
        for lab in labs:
            assert lab["url"].startswith("https://"), lab
            assert lab["title"]

    @pytest.mark.asyncio
    async def test_every_lab_url_survives_the_guardrail(self) -> None:
        # The contract that actually matters: a URL this tool hands the model
        # must be one the model is allowed to say out loud.
        for lab in await tools.get_ai_labs():
            text = f"See {lab['url']} for more."
            assert guardrails._strip_disallowed_urls(text) == text, lab["url"]


class TestGetBuildStory:
    @pytest.mark.asyncio
    async def test_returns_the_shape_the_instruction_promises(self) -> None:
        story = await tools.get_build_story()
        for key in ("summary", "stats", "method", "harness", "highlights", "sourceUrl"):
            assert key in story, f"build-story.json is missing {key!r}"

    @pytest.mark.asyncio
    async def test_stats_are_dated(self) -> None:
        # Atlas is told to quote these as-of rather than as-live. Without asOf
        # it has nothing to date them with and will assert a stale count.
        stats = (await tools.get_build_story())["stats"]
        assert stats.get("asOf"), "stats must carry an asOf date"
        assert stats["commits"] > 0

    @pytest.mark.asyncio
    async def test_source_url_is_citable(self) -> None:
        # The instruction maps get_build_story to this field for its citation,
        # so it has to be on the citation host allowlist.
        story = await tools.get_build_story()
        assert story["sourceUrl"].startswith("https://github.com/")


class TestLiveAgentsCarryRationale:
    @pytest.mark.asyncio
    async def test_named_agent_carries_tech_decisions(self) -> None:
        # These were being dropped on the floor: agents.json has recorded the
        # architecture reasoning all along, and the tool never passed it on.
        agents = await tools.get_live_agents(agent_name="atlas")
        assert len(agents) == 1
        assert agents[0]["techDecisions"], (
            "Atlas surfaced no techDecisions — the 'why did he build it that "
            "way?' answer is unreachable again"
        )

    @pytest.mark.asyncio
    async def test_unfiltered_list_stays_slim(self) -> None:
        # The rationale is ~4x the summary payload across all agents, and this
        # tool answers plenty of questions that never need it. Keep the
        # unfiltered call cheap.
        for agent in await tools.get_live_agents():
            assert "techDecisions" not in agent

    @pytest.mark.asyncio
    async def test_unmatched_name_falls_back_to_full_list(self) -> None:
        # Better than an empty result the model has to guess its way out of.
        agents = await tools.get_live_agents(agent_name="nonexistent-agent")
        assert len(agents) > 1

    @pytest.mark.asyncio
    @pytest.mark.parametrize("probe", ["a", "at", ""])
    async def test_short_probe_does_not_unlock_detail(self, probe: str) -> None:
        # A one- or two-character probe used to substring-match several agents
        # at once and return build detail for all of them. A prefix that short
        # now falls back to the plain summary list.
        for agent in await tools.get_live_agents(agent_name=probe):
            assert "techDecisions" not in agent

    @pytest.mark.asyncio
    async def test_steps_are_never_returned(self) -> None:
        # `steps` is the request-flow narration for the diagram page. It names
        # live endpoint paths, D1 tables, the retention window and the rate
        # limit — a reconnaissance map that answers no question a visitor
        # actually asks. It must not reach the model on any code path.
        for name in (None, "atlas", "pulse", "nope"):
            for agent in await tools.get_live_agents(agent_name=name):
                assert "steps" not in agent, name


class TestBuildStoryIsNotAnInventory:
    """The corpus text itself must not read out as a directory listing.

    Prompt rules alone can't hold this: `content/*.json` ships to Pages and is
    fetchable by URL, so the source text is the real control surface.
    """

    @pytest.mark.asyncio
    async def test_no_literal_slash_command_names(self) -> None:
        blob = json.dumps(await tools.get_build_story())
        for token in ("/create-spec", "/implement-spec", "/ship", "/publish"):
            assert token not in blob, f"build story still names {token}"

    @pytest.mark.asyncio
    async def test_no_internal_paths_or_schema_terms(self) -> None:
        blob = json.dumps(await tools.get_build_story()).lower()
        for token in (".claude/", "agent_interactions", "audit log schema", "/api/"):
            assert token not in blob, f"build story still exposes {token!r}"
