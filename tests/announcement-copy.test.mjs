// Guards the copy in content/announcement.json, the top announcement bar.
//
// Run: node --test tests/announcement-copy.test.mjs
//
// On a phone the bar's text column is only about 270px wide. The full sentence
// fits in two lines at the default text size and is cut off at 115% and up
// (Android's font size setting), which is how a real visitor lost the end of
// "Watch it work." So phones show `mobileText`, kept short enough for one line
// up to 130% text size. (Centred on the screen, the column is only ~230px.) This fails if a new announcement skips it or runs long.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ann = JSON.parse(fs.readFileSync(new URL("../content/announcement.json", import.meta.url), "utf8"));

const MAX_TEXT = 80;     // one line on a laptop
const MAX_MOBILE = 24;   // one line on a phone up to 130% text size

test("the laptop sentence fits one line", () => {
    assert.ok(ann.text.length <= MAX_TEXT, `text is ${ann.text.length} characters, keep it to ${MAX_TEXT}`);
});

test("phones get a short line, because the full sentence gets cut off at larger text sizes", () => {
    const short = ann.mobileText || "";
    assert.ok(
        short || ann.text.length <= MAX_MOBILE,
        "add a mobileText of 24 characters or fewer (see /announce), the full text is too long for phones"
    );
    if (short) assert.ok(short.length <= MAX_MOBILE, `mobileText is ${short.length} characters, keep it to ${MAX_MOBILE}`);
});

test("no em-dashes or en-dashes in the copy", () => {
    for (const k of ["text", "mobileText", "cta"]) {
        assert.ok(!/[–—]/.test(ann[k] || ""), `${k} has a dash, use a comma or a period`);
    }
});
