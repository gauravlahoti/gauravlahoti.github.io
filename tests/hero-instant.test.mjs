// Guards the "hero appears all at once" behavior.
//
// Run: node --test tests/hero-instant.test.mjs
//
// The hero used to hide its pieces (opacity 0, [hidden], data-hidden) and reveal them one
// by one from a script timeline over ~3 seconds. That staging was what made the page feel
// like it was "loading everything", and the swap from plain text to animated letter spans
// was a visible flash and layout jump. Now everything is visible in the HTML and CSS from
// the first paint. This test fails if a hero piece goes back to starting hidden.
//
// No dependencies: Node's built-in runner, reading the real files.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const html = read("index.html");
const css = read("assets/css/layout.css") + "\n" + read("assets/css/components.css");
const mainJs = read("assets/js/main.js");

// Body of the plain rule `<selector> { ... }` (not :hover, not nested in a media query).
function ruleBody(selector) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[1] : null;
}

test("hero pieces do not start at opacity 0", () => {
    for (const sel of [".chrome", ".hero-cta-group", ".cert-rail"]) {
        const body = ruleBody(sel);
        assert.ok(body !== null, `${sel} rule should exist`);
        assert.ok(!/opacity\s*:\s*0\s*[;}]/.test(body + ";"), `${sel} must not start hidden with opacity: 0`);
    }
});

test("the agents link and the phone bottom bar are visible in the HTML", () => {
    const link = /<a[^>]*class="[^"]*hero-agents-link[^"]*"[^>]*>/.exec(html);
    assert.ok(link, "hero agents link should exist");
    assert.ok(/\bis-shown\b/.test(link[0]), "agents link must carry is-shown so it is visible with no script");
    assert.ok(!/\bhidden\b/.test(link[0]), "agents link must not be [hidden]");

    const bar = /<aside[^>]*data-mobile-bottombar[^>]*>/.exec(html);
    assert.ok(bar, "mobile bottom bar should exist");
    assert.ok(!/data-hidden/.test(bar[0]), "bottom bar must not start hidden (it still hides on scroll down)");
});

test("the intro timeline and the letter and word splitting are gone", () => {
    for (const gone of ["scheduleHeroReveal", "splitChars", "splitWords", "scrambleName"]) {
        assert.ok(!mainJs.includes(gone), `main.js should no longer contain ${gone}`);
    }
    assert.ok(!/\.hero-name\s+\.char/.test(css), "no .hero-name .char styles");
    assert.ok(!/\.hero-tagline\s+\.word/.test(css), "no .hero-tagline .word styles");
});

test("the counter and the Atlas widget no longer wait for a timer or for idle", () => {
    assert.ok(!/REVEAL_AT/.test(mainJs), "no fixed reveal delay for the questions counter");
    assert.ok(!/countUp\(/.test(mainJs), "no count-up animation");
    const widget = /function initAgentWidgetOnBoot[\s\S]*?\n}\n/.exec(mainJs);
    assert.ok(widget, "initAgentWidgetOnBoot should exist");
    assert.ok(!/requestIdleCallback/.test(widget[0]), "the widget must not wait for browser idle");
});

test("the CSS has no stray 'undefined' left over from a template", () => {
    assert.ok(!/}undefined/.test(css), "found '}undefined' in the CSS");
});
