// Spec 111: referrer parsing and the note-context shaping. Run with
//   node --test 'backend/test/**/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteContext, referrerHost } from "../src/digest.js";

test("referrerHost reads the bare hostnames page_views stores", () => {
    assert.equal(referrerHost("www.linkedin.com"), "linkedin");
    assert.equal(referrerHost("lnkd.in"), "linkedin");
    assert.equal(referrerHost("www.google.co.in"), "google");
    assert.equal(referrerHost("gauravlahoti.dev"), null);        // own site
    assert.equal(referrerHost("https://www.google.com/"), "google");
    assert.equal(referrerHost("android-app://com.linkedin.android/"), "linkedin");
    assert.equal(referrerHost(""), "direct");
    assert.equal(referrerHost("news.ycombinator.com"), "news.ycombinator.com");
});

// A fake `run` that answers each of noteContext's three queries.
function fakeRun({ views = [], chat = {}, modes = [] }) {
    const seen = [];
    const run = async (sql, binds) => {
        seen.push(binds);
        if (sql.includes("FROM page_views")) return views;
        if (sql.includes("COUNT(*) AS turns")) return [chat];
        if (sql.includes("DISTINCT")) return modes.map((mode) => ({ mode }));
        return [];
    };
    return { run, seen };
}

test("noteContext: arrival source, ordered distinct pages, place, modes", async () => {
    const { run, seen } = fakeRun({
        views: [
            { path: "/", referrer: "www.linkedin.com", city: "Pune", country: "IN", viewed_at: 100 },
            { path: "/ai-labs/mcp-lab/", referrer: "gauravlahoti.dev", city: "Pune", country: "IN", viewed_at: 160 },
            { path: "/", referrer: "gauravlahoti.dev", city: "Pune", country: "IN", viewed_at: 220 },
        ],
        chat: { turns: 4, first_turn: 180, country: "IN", city: "Pune" },
        modes: ["text", "avatar"],
    });
    const ctx = await noteContext(run, "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
    assert.deepEqual(ctx, {
        referrer: "linkedin", pages: ["/", "/ai-labs/mcp-lab/"], city: "Pune", country: "IN",
        first_seen: 100, turns: 4, modes: ["text", "avatar"],
    });
    assert.ok(seen.every((b) => b[0] === "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"));
});

test("noteContext: no page views falls back to the chat's place and time", async () => {
    const { run } = fakeRun({ chat: { turns: 2, first_turn: 500, country: "SG", city: "Singapore" }, modes: ["voice"] });
    const ctx = await noteContext(run, "abcdefgh-1234");
    assert.equal(ctx.referrer, null);
    assert.deepEqual(ctx.pages, []);
    assert.equal(ctx.city, "Singapore");
    assert.equal(ctx.first_seen, 500);
});

test("noteContext: a session id that isn't one is refused before any query", async () => {
    const { run, seen } = fakeRun({});
    assert.equal(await noteContext(run, "x' OR 1=1 --"), null);
    assert.equal(await noteContext(run, ""), null);
    assert.equal(seen.length, 0);
});
