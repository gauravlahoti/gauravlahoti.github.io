#!/usr/bin/env node
// gen-sitemap.mjs — writes sitemap.xml at the repo root (spec 103).
// Run: node scripts/gen-sitemap.mjs
// Also run at the end of gen-post-pages.mjs, so /add-post keeps it current.
//
// Lists the static pages plus every insight that has a page on disk.
// Redirect stubs (ai-labs/rag-lab, ai-labs/agentic-harness) point off-site,
// so they are deliberately left out.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://gauravlahoti.dev";

const STATIC_PAGES = [
    "/",
    "/selected-work/",
    "/live-agents/",
    "/ai-labs/",
    "/ai-labs/mcp-lab/",
    "/ai-labs/engineering-loops/",
    "/ai-labs/agent-ready/",
];

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
    ...STATIC_PAGES.map((p) => entry(p)),
    ...insights.map((p) => entry(`/insights/${p.slug}/`, p.date)),
    `</urlset>`,
    ``,
].join("\n");

writeFileSync(join(ROOT, "sitemap.xml"), xml);
console.log(`sitemap.xml: ${STATIC_PAGES.length} pages + ${insights.length} insights`);
