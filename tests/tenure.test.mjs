// Guards assets/js/tenure.js, the one place that turns role dates into "7 yrs 3 mos".
//
// Run: node --test tests/tenure.test.mjs
//
// Two layers:
//   1. The rules themselves, with a faked clock: both months count, a zero part is left
//      out ("4 yrs", never "4 yrs 0 mos"), one is singular, an open role runs to now.
//   2. content/profile.json: the stored text for every FINISHED role and company must equal
//      what the dates say. Open-ended roles are skipped on purpose: their text changes every
//      month, so checking them against the clock would make this test fail on the 1st of the
//      month for no real reason. A monthly GitHub Action keeps those fresh
//      (scripts/update-tenure.mjs --write).
//
// No dependencies: Node's built-in runner against the real module.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { monthsBetween, formatMonths, spanLabel, companyLabel } from "../assets/js/tenure.js";

const profile = JSON.parse(fs.readFileSync(new URL("../content/profile.json", import.meta.url), "utf8"));

// Local-time Date for "the 15th of that month", like a visitor's browser would give.
const on = (year, month1) => new Date(year, month1 - 1, 15);

test("both the start month and the end month count", () => {
    assert.equal(monthsBetween("2019-09", "2021-05"), 21);
    assert.equal(monthsBetween("2021-06", "2025-05"), 48);
    assert.equal(monthsBetween("2018-06", "2018-06"), 1, "same month is one month");
});

test("formatMonths leaves out a zero part and uses singular for one", () => {
    assert.equal(formatMonths(1), "1 mo");
    assert.equal(formatMonths(7), "7 mos");
    assert.equal(formatMonths(12), "1 yr");
    assert.equal(formatMonths(15), "1 yr 3 mos");
    assert.equal(formatMonths(48), "4 yrs", "never '4 yrs 0 mos'");
    assert.equal(formatMonths(49), "4 yrs 1 mo");
    assert.equal(formatMonths(87), "7 yrs 3 mos");
    assert.equal(formatMonths(0), "");
    assert.equal(formatMonths(NaN), "");
});

test("an open role runs to the current month (15 Nov 2026)", () => {
    const now = on(2026, 11);
    assert.equal(spanLabel("2025-06", null, now), "1 yr 6 mos", "Manager");
    assert.equal(spanLabel("2025-06", "", now), "1 yr 6 mos", "empty end also means present");
});

test("the label rolls forward on its own when the month changes", () => {
    assert.equal(spanLabel("2025-06", null, on(2026, 11)), "1 yr 6 mos");
    assert.equal(spanLabel("2025-06", null, on(2026, 12)), "1 yr 7 mos");
    assert.equal(spanLabel("2025-06", null, on(2027, 5)), "2 yrs", "24 months, no '0 mos'");
    assert.equal(spanLabel("2025-06", null, on(2027, 6)), "2 yrs 1 mo");
});

test("a company runs from its first role to its last end, or to now if one is open", () => {
    const deloitte = profile.experience.find((c) => c.company === "Deloitte");
    assert.equal(companyLabel(deloitte, on(2026, 11)), "7 yrs 3 mos");
    assert.equal(companyLabel(deloitte, on(2026, 12)), "7 yrs 4 mos");
    const accenture = profile.experience.find((c) => c.company === "Accenture");
    assert.equal(companyLabel(accenture, on(2026, 11)), "3 yrs 3 mos", "finished stay ignores the clock");
});

test("unusable dates give an empty label, so callers can fall back to stored text", () => {
    assert.equal(spanLabel("", null), "");
    assert.equal(spanLabel("2019-13", null), "");
    assert.equal(spanLabel("not a date", "2020-01"), "");
    assert.equal(spanLabel("2021-06", "2019-01"), "", "end before start");
    assert.equal(companyLabel({ roles: [] }), "");
    assert.equal(companyLabel(null), "");
});

test("stored text for every finished role matches its dates", () => {
    const wrong = [];
    for (const co of profile.experience) {
        for (const r of co.roles || []) {
            if (!r.end) continue; // open role: changes monthly, kept fresh by the monthly job
            const want = spanLabel(r.start, r.end);
            if (r.duration !== want) wrong.push(`${co.company} / ${r.title}: stored "${r.duration}", dates say "${want}"`);
        }
    }
    assert.deepEqual(wrong, [], "run: node scripts/update-tenure.mjs --write");
});

test("stored text for every finished company matches its dates", () => {
    const wrong = [];
    for (const co of profile.experience) {
        if ((co.roles || []).some((r) => !r.end)) continue; // still there: monthly job keeps it fresh
        const want = companyLabel(co);
        if (co.tenure !== want) wrong.push(`${co.company}: stored "${co.tenure}", dates say "${want}"`);
    }
    assert.deepEqual(wrong, [], "run: node scripts/update-tenure.mjs --write");
});
