// The key -> place map Atlas shows pages from (spec 78, assets/js/site-stage.js).
//
// Run: node --test tests/site-stage.test.mjs
//
// The avatar names a target by key, and this map is the only thing that turns
// a key into somewhere on screen. So it must never hand back anything but a
// section of the home page or a path on this site, an unknown key (including
// the ones every JS object inherits) must resolve to nothing, and every place
// it names must really exist in the repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SITE_TARGETS, resolveTarget } from "../assets/js/site-stage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every page is a path on this site, never a URL", () => {
    for (const [key, t] of Object.entries(SITE_TARGETS)) {
        if (!t.path) continue;
        assert.match(t.path, /^\/[a-z0-9-]+(\/[a-z0-9-]+)*\/$/, `${key}: ${t.path}`);
    }
});

test("every page exists in the repo", () => {
    for (const [key, t] of Object.entries(SITE_TARGETS)) {
        if (t.path) assert.ok(existsSync(join(ROOT, t.path, "index.html")), `${key}: ${t.path}index.html`);
    }
});

test("every section exists on the home page", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    for (const [key, t] of Object.entries(SITE_TARGETS)) {
        if (t.section) assert.ok(html.includes(`id="${t.section}"`), `${key}: #${t.section}`);
    }
});

test("each target is a page or a section, with a title", () => {
    for (const [key, t] of Object.entries(SITE_TARGETS)) {
        assert.ok(Boolean(t.path) !== Boolean(t.section), key);
        assert.ok(typeof t.title === "string" && t.title.length > 0, key);
    }
});

test("unknown keys resolve to nothing", () => {
    for (const key of ["", "rag-lab", "https://evil.example", "/admin", "__proto__", "constructor", "toString", null, undefined, 42]) {
        assert.equal(resolveTarget(key), null, String(key));
    }
    assert.equal(resolveTarget("mcp-lab").path, "/ai-labs/mcp-lab/");
});

// Spec 80: things inside pages, by pattern.
test("agents, their diagrams and Loops layers resolve to paths on this site", () => {
    assert.equal(resolveTarget("agent:pulse").path, "/live-agents/?agent=pulse");
    assert.equal(resolveTarget("agent:error-lens:diagram").path, "/live-agents/?agent=error-lens&view=diagram");
    assert.equal(resolveTarget("loops:harness").path, "/ai-labs/engineering-loops/#harness");
});

test("pattern keys never reach outside the site", () => {
    for (const key of [
        "agent:../x", "agent:a/b", "agent:x.y", "agent:https://evil.example", "agent:", "agent:Pulse",
        "agent:pulse:source", "agent:pulse:diagram:x", "loops:everything", "loops:__proto__", "loops:",
    ]) {
        assert.equal(resolveTarget(key), null, key);
    }
});
