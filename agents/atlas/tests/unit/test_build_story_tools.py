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
import re

import pytest

from app import corpus_live, guardrails, tools


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
        for key in ("summary", "sections", "sourceUrl"):
            assert key in story, f"the bare call is missing {key!r}"
        assert story["summary"], "summary carries the whole default answer"

    @pytest.mark.asyncio
    async def test_bare_call_carries_no_detail_prose(self) -> None:
        # The reason this parameter exists (spec #62). Handed four sections of
        # {label, detail} at once, the model mirrors that structure straight
        # into the reply — label becomes a heading, detail becomes a paragraph
        # — and a 4-sentence answer turns into a ~190-word outline. Long
        # replies are also what makes the spoken version stutter, since every
        # extra chunk is another prosody reset and another rate-limited call.
        story = await tools.get_build_story()
        for key in ("method", "harness", "highlights", "constraints"):
            assert key not in story, f"bare call leaked the {key!r} detail"

    @pytest.mark.asyncio
    async def test_sections_advertise_what_can_be_expanded(self) -> None:
        # The model needs to know depth is available without fetching it,
        # or it cannot offer a sensible follow-up.
        story = await tools.get_build_story()
        assert set(story["sections"]) == {
            "method", "harness", "highlights", "constraints",
        }

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "section", ["method", "harness", "highlights", "constraints"]
    )
    async def test_named_section_returns_its_items(self, section: str) -> None:
        story = await tools.get_build_story(section=section)
        assert story[section], f"{section} came back empty"
        for item in story[section]:
            assert item.get("label") and item.get("detail"), item
        # Still only the one section — asking for depth on the workflow must
        # not hand back the other three as well.
        others = {"method", "harness", "highlights", "constraints"} - {section}
        assert not (others & story.keys())

    @pytest.mark.asyncio
    @pytest.mark.parametrize("section", ["nonsense", "", "  ", "summary", "sourceUrl"])
    async def test_unknown_section_falls_back_to_the_summary(self, section: str) -> None:
        # Same rationale as get_live_agents' unmatched agent_name: a usable
        # answer beats an empty result the model has to guess its way out of.
        # "summary"/"sourceUrl" are checked too — they are keys of the result,
        # not sections, and must not be treated as expandable.
        story = await tools.get_build_story(section=section)
        assert story["summary"]
        for key in ("method", "harness", "highlights", "constraints"):
            assert key not in story

    @pytest.mark.asyncio
    async def test_section_is_case_and_whitespace_tolerant(self) -> None:
        story = await tools.get_build_story(section="  Method ")
        assert story["method"]

    @pytest.mark.asyncio
    async def test_source_url_is_citable(self) -> None:
        # The instruction maps get_build_story to this field for its citation,
        # so it has to be on the citation host allowlist. Present on every
        # call shape, because every build-story claim is citable.
        for story in (
            await tools.get_build_story(),
            await tools.get_build_story(section="method"),
            await tools.get_build_story(section="nope"),
        ):
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

    These read the CORPUS, not `tools.get_build_story()`. Since spec #62 the
    tool returns only the summary unless a section is named, so scanning its
    output would quietly stop covering the four detail sections — the tests
    would still pass while guarding almost nothing.
    """

    @pytest.mark.asyncio
    async def test_no_literal_slash_command_names(self) -> None:
        blob = json.dumps(await corpus_live.get_build_story())
        for token in ("/create-spec", "/implement-spec", "/ship", "/publish"):
            assert token not in blob, f"build story still names {token}"

    @pytest.mark.asyncio
    async def test_no_internal_paths_or_schema_terms(self) -> None:
        blob = json.dumps(await corpus_live.get_build_story()).lower()
        for token in (".claude/", "agent_interactions", "audit log schema", "/api/"):
            assert token not in blob, f"build story still exposes {token!r}"

    @pytest.mark.asyncio
    async def test_no_stats_block(self) -> None:
        # Counts are repo telemetry, not portfolio value, and they age into
        # false claims. The whole block was removed rather than kept fresh.
        assert "stats" not in await corpus_live.get_build_story()

    @pytest.mark.asyncio
    async def test_every_section_is_reachable_and_scanned(self) -> None:
        # Guards the guard: if a section is added to build-story.json and not
        # to _BUILD_STORY_SECTIONS, it becomes unreachable through the tool
        # while still shipping to Pages — and the scans below would be the
        # only thing looking at it.
        corpus = await corpus_live.get_build_story()
        extra = set(corpus) - set(tools._BUILD_STORY_SECTIONS) - {"summary", "sourceUrl"}
        assert not extra, f"build-story.json has sections no tool exposes: {extra}"

    @pytest.mark.asyncio
    async def test_carries_no_counts_dates_or_costs(self) -> None:
        """No tallies anywhere in the corpus text.

        This is the guard that matters long-term: a later edit adding "eight
        skills" back would pass every other test here. Counts crept back in
        twice already — spec 58 wrote a full inventory, spec 59 removed the
        listing but kept the numbers on the argument that they were "the
        credibility". They aren't; a count is just a smaller inventory.
        """
        story = dict(await corpus_live.get_build_story())
        story.pop("sourceUrl", None)  # a URL, not a claim
        blob = json.dumps(story)

        assert not re.search(r"\d", blob), (
            f"build story contains digits: {re.findall(r'[^,.]*\\d[^,.]*', blob)[:3]}"
        )

        # Spelled-out tallies: a count word directly qualifying a noun.
        # Bare "one" is allowed — it's grammatical ("one-off", "One spec"),
        # not a tally.
        counts = r"\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|dozens?)\s+\w"
        found = re.findall(counts, blob, re.I)
        assert not found, f"build story states a count: {found}"
