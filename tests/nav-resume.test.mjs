// The Resume link must open the PDF on every page that carries it. It used to
// be href="/#" plus a click handler that forced "/#" on the standalone pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pages = [
  "index.html",
  "live-agents/index.html",
  "ai-labs/index.html",
  "ai-labs/mcp-lab/index.html",
  "ai-labs/agent-ready/index.html",
  "ai-labs/engineering-loops/index.html",
];
const scripts = [
  "agents-page", "ai-concepts-page", "mcp-lab-page",
  "webmcp-lab-page", "engineering-loops-page",
];

for (const page of pages) {
  test(`${page}: every nav Resume link points at /resume.pdf`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const links = [...html.matchAll(/<a\b[^>]*>\s*Resume\s*<\/a>/g)].map((m) => m[0]);
    assert.ok(links.length >= 2, "expected a nav link and a drawer link");
    for (const a of links) assert.match(a, /href="\/resume\.pdf"/, a);
    assert.doesNotMatch(html, /data-resume-trigger/);
  });
}

for (const s of scripts) {
  test(`${s}.js no longer redirects Resume to "/#"`, () => {
    const js = readFileSync(new URL(`../assets/js/${s}.js`, import.meta.url), "utf8");
    assert.doesNotMatch(js, /data-resume-trigger/);
  });
}
