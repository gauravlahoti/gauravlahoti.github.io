# Spec 100: Selected Work case studies on the homepage

## Problem
The homepage had no proof-of-work section.

## What shipped
- `#work` Selected Work: three case studies, one per kind of AI system (conversational: Atlas, ambient agentic workflow: the document agent, multi-agent: ErrorLens), each with problem, how it works and an outcome with a number, from `content/selected-work.json`, rendered by `assets/js/selected-work.js`.
- The section sits between Career and About and loads lazily (`initLazySection` in `main.js`). Their height is reserved in CSS.
- `webmcp.js` `go_to` accepts `work`.
- No new nav entry. The top menu is already full and six hand-copied navs would all change.

## Motion and interaction (the rich layer)
- **Selected Work:** cards rise in on scroll (CSS scroll-driven animation, left out where unsupported). Each card plays once when well on screen: the architecture pipeline lights node by node while a packet runs down its rail, and the outcome number counts up beside a graphic that draws that same number: a 24-hour dial lighting up hour by hour (conversational, 24/7), 19 workflow steps with the 3 AI ones lit (document agent), a dial filling to 0.85 (ErrorLens). Data lives in `outcome.viz` in `selected-work.json`; a test checks each graphic against the stated value.
- **Cards:** a pointer spotlight follows the cursor on hover-capable devices.
- **Rules:** the base styles are the finished state, so reduced motion shows a complete card. All motion is opted in under `prefers-reduced-motion: no-preference`, plays once, and ends in under five seconds, so no pause control is needed. Nothing loops. No dependency beyond what the page already loads.
- Files: `fx.js` (spotlight, seen-once observer, count-up), `work-viz.js`, plus the rich-layer block at the end of `components.css`.

## Audience and wording
Written to be read by hiring teams and non-engineers, not just architects: plain sentences, a "kind" pill on each card (Conversational AI, Ambient agentic workflow, Multi-agent system) so the range of what the owner can build reads at a glance, and "How it works" instead of "Architecture". No card says prototype, stub, demo or client (a test enforces it).

## Scope decision
An AI Lab strip below Selected Work was built and then removed on request: the section is the three case studies only. The labs stay reachable from the top menu and `/ai-labs/`.

## Scope rule
Selected Work shows only the owner's own AI work: no employer-branded or client work, and no client geography. The telecom (fiber broadband) project was in the first draft and was removed on request. It stays in the career section.

## Atlas framing
The Atlas card is written as a pattern any organisation could use to answer customers or employees, not as a tool for one person's website, because a one-site framing hides that the design scales. What it claims is limited to what the repo records: it runs on Cloud Run (which scales with demand), it answers by text, voice or avatar, it looks answers up in the content it is given with no redeploy, and it can email on request. The repo records no other deployment, so the card does not say one exists.

## Honesty rules (the reason this spec exists)
A case study may only call a number **measured** when the repo backs it. An owner's claim with no recorded baseline is an **estimate**, and a figure that follows from how the system is built is a **design fact** ("By design"). Each card says which.
- Conversational card, framed as a high-impact use case: repetitive, high-volume work, tied to outcomes the business measures. Headline **~500x** lower cost per answer than a human-assisted contact, tagged *Measured · benchmarked*.
  - Cost: ~17.5k input and ~150 output tokens per answer (`chat-timing` logs, 11 to 20 Nov 2026) at Vertex Gemini 3.6 Flash list price, $0.75 / $3.75 per 1M (intro) or $1.50 / $7.50 from 1 Jan 2027, comes to 1.4¢ to 2.7¢ per answer. Against Gartner's $13.50 median per assisted contact (2024) that is ~986x at today's price and ~493x at the 2027 price, hence "~500x". This is model spend only; hosting is a small fixed cost.
  - Speed: the card states **complete answer < 3 s, TTFT < 1 s**. These are the owner's figures, set at their request on 22 Nov 2026. The production `chat-timing` logs (11 to 20 Nov 2026) measured complete answers at p50 4.0 s and p95 6.6 s, and TTFT at p50 2.9 s and p95 6.2 s. Re-measure after any latency work and keep the card in line with the logs. The baseline is a live agent's first reply in chat, ~35 s (LiveChat). The ~12 h email baseline was dropped as unrealistic.
  - Fourth tile is **Productivity: 14k hrs** of agent time freed per 100k questions. That is 100,000 × ~8 min 25 s average live-chat duration (LiveChat Customer Service Report), the same 100k volume the Scale tile uses. It is a projection, not measured traffic. "Interest becomes a lead" was dropped because it only holds for customer sales.
  - Scale: configured capacity of 400 concurrent conversations (Cloud Run maxScale 5 × concurrency 80), which is configured, not load-tested. The 100k-a-month projection is 100,000 × the unit cost against 100,000 × $13.50. Traffic (850+ answered, live counter) is a footnote only, because it reads as pilot-sized to an enterprise reader.
  - The test recomputes every one of these from the stated inputs.
- Document agent (built on invoices, worded generically): "10x cheaper than standard invoice processing, and faster" is the owner's estimate and is labelled **Estimate**, not Measured. The repo records no baseline for it. What the repo does back, and a test checks: only 3 of 19 steps use an AI model, and a typical invoice costs "a fraction of a cent" in model calls (build notes in `demo.md`). The copy describes what the agent decides and routes. It does not claim live posting into SAP, Coupa or ServiceNow, because those writes are not wired up yet, and a test guards that.
- ErrorLens: a 0.85 similarity match skips research (design threshold, not a measured outcome).
- ErrorLens use case and solution (rewritten 22 Nov 2026, from the owner's solution brief and the `error-lens` card in `agents.json`): the "30 to 90 minutes" per cryptic error and fixes lost to chat threads, runbooks and people's heads are the owner's figures; "42% of institutional knowledge is unique to the individual" is Panopto's Workplace Knowledge and Productivity Report (2018, vendor-commissioned survey of ~1,000 US workers). The four steps are router + signal extraction, semantic search over solved errors (0.85), parallel docs + community research ranked by confidence (up to 3 fixes), and recording/embedding confirmed fixes. Built with adds Developer Knowledge MCP and Google Search, both in the brief's technology table. The brief's projected "45 min to under 30 s by week 12" is not used: it is a projection, not a measurement.
- `demo.md` is an internal briefing and its text is not reused.
- `tests/selected-work.test.mjs` enforces all of this.

## The efficiency box: one strict template
Every card's box is identical in shape and says nothing but efficiency:
- **Headline:** a number plus a phrase of 5 words or fewer. It counts up on scroll.
- **Four tiles,** always in this order: Cost, Speed, Scale, Productivity.
- **Each tile** is a metric (12 characters or fewer, so it never wraps) plus one line (25 characters or fewer, so it never wraps at desktop width).
- **No graphics, paragraphs, sources or tags in the box.** Sources live in the use-case text, and no card carries a qualifier.
- The dot grid and agent diagram were removed on request.

| Card | Headline | Cost | Speed | Scale | Productivity |
|---|---|---|---|---|---|
| 01 | ~500x lower cost per answer | $0.01–0.03 · per answer vs $13.50 | < 3 s · vs ~35 s for a live agent | 400 · concurrent chats | ~1 day/wk · back per employee |
| 02 | ~68x lower model cost per invoice | $0.14 · per invoice vs $9.40 | ~25 s · email to ERP, per invoice | $415/mo · 3k invoices vs $28.2k | Up to 3 FTE · AP capacity at 3k/mo |
| 03 | ~2x faster incident research | $0 · research on repeat errors | Parallel · 2 agents search at once | 3 · independent services | Compounding · every fix reused |

**Basis, card 02:** the owner's solution brief, shared 22 Nov 2026. It supersedes the older `demo.md` notes for cost and speed.
- **Cost:** Gemini model cost of **$0.1382 per average invoice** (15 KB, 4 pages, digital text) against the **$9.40** industry average (Ardent Partners, AP Metrics That Matter 2025, via WEX). That gives ~68x. Model cost only; hosting, Model Armor and human review are excluded, as the brief states.
- **Scale:** at 3,000 invoices a month (an illustrative volume), about $415 against $28,200.
- **Speed:** **24.4 s** elapsed, intake to ERP, in the brief's run snapshot. That is a single run, not a percentile.
- **Use case:** the brief's own framing, that template-based OCR breaks on a new vendor, a revised layout or a scanned copy.
- **Pricing change:** the brief notes that Gemini introductory pricing rises on 1 Jan 2027, so recompute the cost then.

An interaction bundle (lever switcher, source popovers, expand dialog) was built and reverted on 22 Nov 2026.

## Own page and home teaser
The full cards live at **/selected-work/** (`selected-work/index.html`, booted by `assets/js/selected-work-page.js`, which reuses the AI Lab hub's chrome). "Selected Work" sits in every nav and drawer, cyan, right before Live Agents: on the home page, Live Agents, the four AI Lab pages, `scripts/gen-post-pages.mjs` and the 13 generated Insights pages.

The home page keeps a compact teaser between Career and About: each card's pill, headline number and phrase, plus "See the case studies →". It is rendered by `initSelectedWorkTeaser` from the same JSON, so the numbers can't drift. The section intro line was removed, and the eyebrow reads `// shipped.systems()` so it doesn't repeat the heading.

**Productivity tiles:**
- **01 · ~1 day/wk back per employee.** McKinsey: about 19% of the workday is spent finding information. This is the size of the opportunity, not a measurement of this system.
- **02 · Up to 3 FTE of AP capacity at 3k/mo.** 36k invoices a year ÷ APQC's median of ~12,000 invoices per AP FTE (APQC measure page, 3,665 companies). "Up to", because exceptions still need people.

## Module versioning fix
`selected-work.js` and `work-viz.js` load their sibling modules with their own `?v=` query (`new URL(import.meta.url).search`). Plain static imports had let the browser keep a stale `work-viz.js` after a change, which silently dropped the new visual. The same would have happened to returning visitors after a deploy.

## Known gaps
- Atlas does not know the case studies. A new content file needs four Atlas edits and a redeploy (`corpus_live.py`, `tools.py`, `agent.py`, Makefile). The underlying facts are already in `graph.json` and `agents.json`, which Atlas reads.
- `SITE_TARGETS` (`site-stage.js`) and `SHOW_TARGETS` (`live_brain.py`) are unchanged, so Atlas cannot scroll to the new sections yet.
- ErrorLens has no measured outcome, and the document agent's 10x is an estimate. Replace them with measured figures when they exist (an invoice cost comparison would settle the 10x).
- The document agent is built and tested on invoices. The card is worded generically ("document agent") on purpose, but never claims contracts or other types: only what the repo records is stated. The agent is not on the live-agents page or in Atlas's content, and its intake runs against a bundled sample by default.
- `demo.md` at the repo root ships to the live site (not in the deploy exclude list).

## Definition of done
- [x] Three case studies render with a labelled outcome number.
- [x] No horizontal overflow at 390px; outcome boxes level at desktop.
- [x] `node --test 'tests/**/*.test.mjs'` passes.
- [ ] Verified on the live site after deploy.
