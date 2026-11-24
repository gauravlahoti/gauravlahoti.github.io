#!/usr/bin/env node
// gen-sitemap.mjs — writes sitemap.xml at the repo root (spec 103).
// Run: node scripts/gen-sitemap.mjs
// Also run at the end of gen-post-pages.mjs, so /add-post keeps it current.
//
// Lists the static pages plus every insight that has a page on disk.
// Redirect stubs (ai-labs/rag-lab, ai-labs/agentic-harness) point off-site,
// so they are deliberately left out.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://gauravlahoti.dev";

// Each static page, with the files whose last commit dates it (spec 104):
// the page itself plus the content JSON it renders. lastmod = the newest of
// those commit dates. Needs full git history; deploy.yml checks out with
// fetch-depth: 0, because a shallow clone would date every page "today".
const STATIC_PAGES = [
    ["/", ["index.html", "content/profile.json", "content/graph.json", "content/posts.json"]],
    ["/selected-work/", ["selected-work/index.html", "content/selected-work.json"]],
    ["/live-agents/", ["live-agents/index.html", "content/agents.json"]],
    ["/ai-labs/", ["ai-labs/index.html", "content/ai-concepts.json"]],
    ["/ai-labs/mcp-lab/", ["ai-labs/mcp-lab/index.html", "content/mcp-lab.json"]],
    ["/ai-labs/engineering-loops/", ["ai-labs/engineering-loops/index.html", "content/engineering-loops.json"]],
    ["/ai-labs/agent-ready/", ["ai-labs/agent-ready/index.html", "content/webmcp-lab.json"]],
];

// Newest commit date (YYYY-MM-DD) across files; undefined if git can't say.
function lastCommitDate(files) {
    try {
        const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", ...files], {
            cwd: ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : undefined;
    } catch {
        return undefined;
    }
}

const posts = JSON.parse(readFileSync(join(ROOT, "content", "posts.json"), "utf8"));
const insights = posts
    .filter((p) => p.slug && existsSync(join(ROOT, "insights", p.slug, "index.html")))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

const entry = (path, lastmod) =>
    `  <url>\n    <loc>${ORIGIN}${path}</loc>\n` +
    (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : "") +
    `  </url>`;

const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...STATIC_PAGES.map(([path, files]) => entry(path, lastCommitDate(files))),
    ...insights.map((p) => entry(`/insights/${p.slug}/`, p.date)),
    `</urlset>`,
    ``,
].join("\n");

writeFileSync(join(ROOT, "sitemap.xml"), xml);
console.log(`sitemap.xml: ${STATIC_PAGES.length} pages + ${insights.length} insights`);
