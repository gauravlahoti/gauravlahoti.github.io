// Guards assets/js/announce-hint.js, the pre-paint hint that holds space for the
// announcement bar so the page does not jump when announcement.js adds it.
//
// Run: node --test tests/announce-hint.test.mjs
//
// Two things can go wrong, and both are cheap to catch here:
//   1. The hint's copy of the announcement fields drifts from
//      content/announcement.json (someone edited the JSON by hand, or /announce
//      did not regenerate the hint). The page would then reserve space for the
//      wrong bar, or none. Not broken, but the layout shift comes back.
//   2. The hint's own "is a bar live right now" rules drift from announcement.js.
//
// No dependencies: Node's built-in runner, and the real hint script run inside
// a vm sandbox with a fake document, localStorage and clock.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const hintSrc = fs.readFileSync(new URL("assets/js/announce-hint.js", root), "utf8");
const annJson = JSON.parse(fs.readFileSync(new URL("content/announcement.json", root), "utf8"));

const DAY = 86400000;

function copyInHint() {
    const m = hintSrc.match(/var ANN = (\{.*\}|null);/);
    assert.ok(m, "announce-hint.js must contain a one-line `var ANN = {...};`");
    return JSON.parse(m[1]);
}

// Run the real hint script and report whether it marked the page as pending.
function runHint({ now, dismissedId = null, storageThrows = false }) {
    const added = [];
    const sandbox = {
        document: { documentElement: { classList: { add: (c) => added.push(c) } } },
        localStorage: {
            getItem: (k) => {
                if (storageThrows) throw new Error("denied");
                return k === "ann-dismissed" ? dismissedId : null;
            },
        },
        Date: { now: () => now, parse: Date.parse },
    };
    vm.runInNewContext(hintSrc, sandbox);
    return added;
}

test("the hint's copy matches content/announcement.json", () => {
    const ann = copyInHint();
    assert.ok(ann, "hint has no announcement but announcement.json does: run /announce or update the hint");
    assert.equal(ann.id, annJson.id);
    assert.equal(ann.startsOn, annJson.startsOn);
    assert.equal(ann.durationDays, annJson.durationDays);
});

test("marks the page pending while the bar is live", () => {
    const ann = copyInHint();
    const start = Date.parse(ann.startsOn + "T00:00:00");
    assert.deepEqual(runHint({ now: start + DAY }), ["ann-pending"]);
    assert.deepEqual(runHint({ now: start }), ["ann-pending"], "live from the first instant");
});

test("does nothing before the start date or after the window ends", () => {
    const ann = copyInHint();
    const start = Date.parse(ann.startsOn + "T00:00:00");
    const end = start + (Number(ann.durationDays) || 7) * DAY;
    assert.deepEqual(runHint({ now: start - 1 }), []);
    assert.deepEqual(runHint({ now: end }), [], "window is half-open, like announcement.js");
    assert.deepEqual(runHint({ now: end + 30 * DAY }), []);
});

test("does nothing once the visitor dismissed this announcement", () => {
    const ann = copyInHint();
    const start = Date.parse(ann.startsOn + "T00:00:00");
    assert.deepEqual(runHint({ now: start + DAY, dismissedId: ann.id }), []);
    assert.deepEqual(runHint({ now: start + DAY, dismissedId: "some-older-bar" }), ["ann-pending"]);
});

test("still works when localStorage is blocked", () => {
    const ann = copyInHint();
    const start = Date.parse(ann.startsOn + "T00:00:00");
    assert.deepEqual(runHint({ now: start + DAY, storageThrows: true }), ["ann-pending"]);
});

test("announcement.js clears the pending class on every exit path", () => {
    const js = fs.readFileSync(new URL("assets/js/announcement.js", root), "utf8");
    assert.match(js, /function clearPending\(\)/);
    // not ok / fetch failed / not live / dismissed, plus the success path
    assert.ok((js.match(/clearPending\(\)/g) || []).length >= 5, "each early return and the insert must clear it");
});
