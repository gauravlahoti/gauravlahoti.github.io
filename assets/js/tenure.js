// tenure.js: how long a role, or a whole stay at a company, has lasted, as text.
//
// One place for the counting rules, so the page (trajectory.js), the WebMCP tools
// (webmcp.js), the monthly refresh script (scripts/update-tenure.mjs) and the tests
// can never disagree. Plain ES module, no DOM, no dependencies.
//
// Rules:
// - Dates are months, "YYYY-MM". An empty end means "present".
// - Both the start month and the end month count, the way LinkedIn counts. Sep 2019 to
//   May 2021 is 21 months. For a role that is still going, the current month counts.
// - Output is years and months. A part that is zero is left out ("4 yrs", never
//   "4 yrs 0 mos"; "7 mos", never "0 yrs 7 mos"). One is singular ("1 yr", "1 mo").

// "2019-09" -> a month number we can subtract. Returns null for anything unusable.
function monthIndex(ym) {
    if (typeof ym !== "string") return null;
    const m = /^(\d{4})-(\d{2})$/.exec(ym.trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return year * 12 + (month - 1);
}

// The current month as an index, from a Date (injectable so tests can fake the clock).
function nowIndex(now) {
    return now.getFullYear() * 12 + now.getMonth();
}

// Number of months from `start` to `end`, counting both. `end` empty means now.
// Returns null when the start is missing or the range runs backwards.
export function monthsBetween(start, end, now = new Date()) {
    const s = monthIndex(start);
    if (s === null) return null;
    const e = end ? monthIndex(end) : nowIndex(now);
    if (e === null || e < s) return null;
    return e - s + 1;
}

// 87 -> "7 yrs 3 mos", 48 -> "4 yrs", 7 -> "7 mos", 12 -> "1 yr", 1 -> "1 mo".
export function formatMonths(total) {
    if (!Number.isFinite(total) || total < 1) return "";
    const years = Math.floor(total / 12);
    const months = total % 12;
    const parts = [];
    if (years > 0) parts.push(`${years} ${years === 1 ? "yr" : "yrs"}`);
    if (months > 0) parts.push(`${months} ${months === 1 ? "mo" : "mos"}`);
    return parts.join(" ");
}

// Text for one role: spanLabel("2025-06", null) on 15 Nov 2026 -> "1 yr 6 mos".
// Returns "" when the dates cannot be used, so callers can fall back to stored text.
export function spanLabel(start, end, now = new Date()) {
    const months = monthsBetween(start, end, now);
    return months === null ? "" : formatMonths(months);
}

// Text for a whole stay at one company: from its earliest role start to its last end, or
// to now if any role is still open. Matches how the stored tenure strings were written.
export function companyLabel(company, now = new Date()) {
    const roles = Array.isArray(company && company.roles) ? company.roles : [];
    if (!roles.length) return "";
    let first = null;
    let last = null;
    let open = false;
    for (const r of roles) {
        const s = monthIndex(r.start);
        if (s !== null && (first === null || s < first)) first = s;
        if (!r.end) {
            open = true;
        } else {
            const e = monthIndex(r.end);
            if (e !== null && (last === null || e > last)) last = e;
        }
    }
    if (first === null) return "";
    const endIdx = open ? nowIndex(now) : last;
    if (endIdx === null || endIdx < first) return "";
    return formatMonths(endIdx - first + 1);
}
