// Spec 100: Selected Work. These tests keep the cards honest and on-brief:
// three kinds of AI system, each told as use case -> solution -> efficiency,
// and one strict efficiency template on every card: a headline number with a
// short outcome phrase, then four tiles (Cost, Speed, Scale, Productivity),
// each a metric and one line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const work = JSON.parse(read("content/selected-work.json"));
const agents = JSON.parse(read("content/agents.json"));
const agentList = Array.isArray(agents) ? agents : agents.agents;
const byId = Object.fromEntries(work.studies.map((s) => [s.id, s]));
const cardText = (s) => JSON.stringify({ title: s.title, problem: s.problem, flow: s.architecture.flow, outcome: s.outcome });
const tiles = (id) => Object.fromEntries(byId[id].outcome.levers.map((l) => [l.key, l]));

test("three case studies, each with a use case, solution steps and an efficiency number", () => {
  assert.equal(work.studies.length, 3);
  for (const s of work.studies) {
    assert.ok(s.kind && s.title && s.problem, s.id);
    assert.equal(s.context, undefined, `${s.id}: no per-card "built by" line`);
    assert.ok(s.architecture.flow.length >= 3 && s.architecture.stack.length >= 3, s.id);
    assert.match(s.outcome.value, /\d/, `${s.id} needs a number`);
    assert.ok(s.outcome.label, s.id);
    assert.ok(["measured", "benchmarked", "estimate", "design"].includes(s.outcome.basis), s.id);
  }
});

test("the three kind pills stay exactly as agreed, in Title Case", () => {
  assert.deepEqual(work.studies.map((s) => s.kind), ["Conversational AI", "Ambient Agentic Workflow", "Multi-Agent System"]);
});

test("cards speak about the use case, not the builder or the product names", () => {
  for (const s of work.studies) {
    const t = cardText(s);
    assert.doesNotMatch(t, /built by|built and run|\bI\b|\bmy\b|\bme\b/i, `${s.id} talks about the builder`);
    assert.doesNotMatch(t, /\bAtlas\b|ErrorLens/, `${s.id} names the product`);
  }
});

test("copy has no em-dashes, and no prototype, stub, demo, client or contract wording", () => {
  const all = JSON.stringify(work);
  assert.doesNotMatch(all, /—/);
  assert.doesNotMatch(all, /prototype|\bstub|\bdemo\b|\bclient\b|contract/i);
});

// ── The efficiency template ───────────────────────────────────────────────

test("every efficiency box follows one template: headline + four tiles, metric + one line", () => {
  for (const st of work.studies) {
    const o = st.outcome;
    assert.ok(o.label.split(/\s+/).filter((w) => w !== "·" && w !== "est.").length <= 5, `${st.id}: headline phrase is 5 words or fewer`);
    assert.equal(o.viz.kind, "count", `${st.id}: no graphic in the box, the headline just counts up`);
    assert.equal(`${o.viz.count.prefix || ""}${o.viz.count.to}${o.viz.count.suffix || ""}`, o.value);
    assert.deepEqual(o.levers.map((l) => l.key), ["cost", "speed", "scale", "productivity"], st.id);
    for (const l of o.levers) {
      assert.deepEqual(Object.keys(l).sort(), ["key", "label", "line", "metric"], `${st.id}/${l.key}: metric and one line only`);
      assert.ok(l.metric.length <= 12, `${st.id}/${l.key}: metric fits one line`);
      assert.ok(l.line.length <= 25, `${st.id}/${l.key}: line fits one line`);
      assert.doesNotMatch(l.line, /\(|\.$/, `${st.id}/${l.key}: no source or trailing period in the tile`);
    }
  }
});

test("no card carries a qualifier tag; every headline is a measured or sourced figure", () => {
  for (const st of work.studies) assert.doesNotMatch(st.outcome.label, /est\.|by design/i, st.id);
  assert.doesNotMatch(read("assets/js/selected-work.js"), /work-basis/, "no separate basis tag is rendered");
});

// ── Card 01: conversational ───────────────────────────────────────────────

test("conversational card: every figure sourced or derived from production data", () => {
  const o = byId.atlas.outcome;
  const lv = tiles("atlas");
  assert.equal(o.value, "~500x");
  assert.equal(o.label, "lower cost per answer");

  // Unit cost from production tokens (~17.5k in, ~150 out) at Vertex list price,
  // intro ($0.75/$3.75 per 1M) and 2027 standard ($1.50/$7.50).
  const perAnswer = (inP, outP) => (17_500 * inP + 150 * outP) / 1e6;
  const low = perAnswer(0.75, 3.75), high = perAnswer(1.5, 7.5);
  assert.ok(low >= 0.01 && high <= 0.03, "cost per answer is 1 to 3 cents");
  // ~493x at the 2027 price, ~986x at today's: "~500x" is the conservative read.
  assert.ok(13.5 / high >= 480 && 13.5 / low >= 900);
  assert.equal(lv.cost.metric, "$0.01–0.03");
  assert.match(lv.cost.line, /vs \$13\.50/);

  // Speed: owner-stated (< 3 s). Nov 2026 logs measured p50 4.0 s / p95 6.6 s
  // complete answers; see spec 100. Baseline: a live agent's first chat reply.
  assert.equal(lv.speed.metric, "< 3 s");
  assert.match(lv.speed.line, /~35 s for a live agent/);

  // Scale: configured capacity (Cloud Run 5 instances x 80).
  assert.equal(lv.scale.metric, String(5 * 80));

  // Productivity: knowledge workers spend ~19% of the workday finding information
  // (McKinsey); 19% of a 5-day week is about a day. The size of the opportunity
  // the assistant targets, not a measurement of this system.
  assert.ok(Math.abs(0.19 * 5 - 1) < 0.1);
  assert.equal(lv.productivity.metric, "~1 day/wk");
  assert.match(byId.atlas.problem, /fifth of the workday searching for information \(McKinsey\)/);

  // The human baselines are the problem statement, so their sources live in the use case.
  assert.match(byId.atlas.problem, /\$13\.50 \(Gartner\)/);
  assert.match(byId.atlas.problem, /35 seconds just for an agent's first reply \(LiveChat\)/);
  assert.doesNotMatch(JSON.stringify(byId.atlas), /SuperOffice|12 h/, "no email straw man");
});

// ── Card 02: ambient workflow ─────────────────────────────────────────────

test("document card: owner's measured model cost against Ardent's $9.40, and the volume math holds", () => {
  // Owner's solution brief (22 Nov 2026): Gemini model cost $0.1382 per average
  // invoice (15 KB, 4 pages, digital text) vs Ardent Partners' $9.40 industry
  // average (AP Metrics That Matter 2025, via WEX). Model cost only.
  const s = byId["document-workflow"];
  const lv = tiles("document-workflow");
  const model = 0.1382, industry = 9.4;
  assert.equal(s.outcome.value, "~68x");
  assert.ok(Math.abs(industry / model - 68) < 1, "9.40 / 0.1382 is about 68");
  assert.equal(lv.cost.metric, "$0.14");
  assert.match(lv.cost.line, /vs \$9\.40/);
  assert.equal(lv.scale.metric, "$415/mo");
  assert.equal(Math.round(3000 * model), 415);
  assert.match(lv.scale.line, /3k invoices vs \$28\.2k/);
  assert.equal(3000 * industry, 28_200);
  assert.equal(lv.speed.metric, "~25 s", "a 24.4 s end-to-end run in the owner's snapshot");
  assert.match(s.problem, /\$9\.40 to process \(Ardent Partners\)/, "the benchmark's source is in the use case");
  assert.match(s.problem, /template-based OCR/);
  // Productivity: 3k invoices/month = 36k a year, at APQC's median of ~12,000
  // invoices per AP FTE a year = 3 FTE of capacity. "Up to", since exceptions still need people.
  assert.equal(lv.productivity.metric, "Up to 3 FTE");
  assert.equal((3000 * 12) / 12_000, 3);
  assert.match(s.problem, /12,000 invoices a year \(APQC\)/);
  assert.match(read("demo.md"), /flagged minority/, "exceptions-only rests on the build notes too");
  assert.doesNotMatch(s.architecture.flow.join(" "), /\bposts?\b[^.]*\b(SAP|Coupa|ServiceNow)\b/i);
});

// ── Card 03: multi-agent ──────────────────────────────────────────────────

test("multi-agent card: every claim rests on ErrorLens's own card", () => {
  const lv = tiles("errorlens");
  const card = JSON.stringify(agentList.find((a) => a.id === "error-lens"));
  assert.equal(byId.errorlens.outcome.value, "~2x");
  assert.match(card, /roughly in half/);
  assert.equal(lv.cost.metric, "$0");
  assert.match(card, /skip the research pipeline/);
  assert.match(card, /≥0\.85/);
  assert.equal(lv.scale.metric, "3");
  assert.match(card, /Cloud Run \(3 services\)/);
  assert.match(card, /independently deployed/);
});

test("multi-agent card: the use case covers tacit knowledge and solved errors, the solution semantic search", () => {
  const s = byId.errorlens;
  // Owner's solution brief: 30–90 min per cryptic error, fixes lost to chat
  // threads, runbooks and people's heads. Panopto Workplace Knowledge and
  // Productivity Report (2018): 42% of institutional knowledge is unique to the individual.
  assert.match(s.problem, /30 to 90 minutes/);
  assert.match(s.problem, /42% of institutional knowledge is unique to the individual \(Panopto\)/);
  assert.match(s.problem, /already solved/);
  const flow = s.architecture.flow.join(" ");
  assert.match(flow, /Semantic search over the team's solved errors/);
  assert.match(flow, /0\.85 similarity/, "the same threshold as the agent card's ≥0.85");
  assert.match(flow, /in parallel/);
  assert.match(flow, /tacit knowledge compounds/);
  assert.equal(s.architecture.flow.length, 4, "four steps, so the rows line up with the other cards");
});

// ── Page wiring and stack ────────────────────────────────────────────────

test("home page keeps a compact teaser between Career and About that links to the full page", () => {
  const html = read("index.html");
  const at = (id) => html.indexOf(`<section id="${id}"`);
  assert.ok(at("career") < at("work") && at("work") < at("about"));
  assert.match(html, /data-work-teaser-root/);
  assert.doesNotMatch(html, /data-work-root/, "the full cards live on /selected-work/");
  assert.match(html, /class="work-teaser-cta" href="\/selected-work\/" data-page-link/);
  assert.equal(at("labs"), -1);
  assert.match(read("assets/js/main.js"), /initSelectedWorkTeaser/);
});

test("/selected-work/ is a standalone page with the full cards", () => {
  const page = read("selected-work/index.html");
  assert.match(page, /<base href="\/">/);
  assert.match(page, /<h1 class="work-title">Selected work\.<\/h1>/);
  assert.match(page, /data-work-root/);
  assert.match(page, /assets\/js\/selected-work-page\.js\?v=/);
  assert.match(page, /href="\/selected-work\/" class="nav-link-active nav-live-link" data-page-link aria-current="page">Selected Work/);
  assert.match(page, /https:\/\/gauravlahoti\.dev\/selected-work\//);
  assert.match(read("assets/js/selected-work-page.js"), /initSelectedWork/);
});

test("every page's nav and drawer link to Selected Work, right before Live Agents", () => {
  const pages = ["index.html", "selected-work/index.html", "live-agents/index.html", "ai-labs/index.html",
    "ai-labs/mcp-lab/index.html", "ai-labs/agent-ready/index.html", "ai-labs/engineering-loops/index.html", "scripts/gen-post-pages.mjs"];
  for (const p of pages) {
    const src = read(p);
    const links = [...src.matchAll(/<a href="\/selected-work\/"[^>]*>Selected Work<\/a>\s*<a href="\/live-agents\/"/g)];
    assert.equal(links.length, 2, `${p}: nav and drawer`);
  }
});

test("WebMCP go_to can reach the work section", () => {
  const src = read("assets/js/webmcp.js");
  const lists = src.match(/\["top", "career", "work", "about", "insights", "chat"\]/g) || [];
  assert.equal(lists.length, 2);
});

test("motion stays opt-in, finite, and the box has no diagrams", () => {
  assert.match(read("assets/js/fx.js"), /prefers-reduced-motion: reduce/);
  const css = read("assets/css/components.css");
  const rich = css.slice(css.indexOf("Rich layer for Selected Work"));
  assert.match(rich, /@media \(prefers-reduced-motion: no-preference\)/);
  assert.doesNotMatch(rich, /infinite/);
  assert.doesNotMatch(rich, /\.viz-agents|\.dots-grid|\.ag-/, "diagram styles are gone");
  assert.doesNotMatch(read("assets/js/work-viz.js"), /function (dots|agents)\(/);
});

test("Claude Code appears only on the cards built with it, and the build story backs the assistant", () => {
  const has = (id) => byId[id].architecture.stack.includes("Claude Code");
  assert.ok(has("atlas") && has("document-workflow"));
  assert.ok(!has("errorlens"), "the multi-agent system was not built with Claude Code");
  assert.match(read("content/build-story.json"), /spec-driven with Claude Code/);
});

test("decision models are named on the ambient workflow card only, for triage and model selection", () => {
  const doc = byId["document-workflow"];
  const flow = doc.architecture.flow.join(" ");
  assert.match(flow, /decision model[^.]*(signal|noise)/i);
  assert.match(flow, /decision model[^.]*complexity[^.]*model/i);
  assert.ok(doc.architecture.stack.includes("Decision models"));
  for (const id of ["atlas", "errorlens"]) assert.doesNotMatch(cardText(byId[id]), /decision model/i, id);
});

test("Built with shows real variety: each card lists at least five tools from its own stack", () => {
  for (const s of work.studies) assert.ok(s.architecture.stack.length >= 5, s.id);
});
