#!/usr/bin/env node
// update-tenure.mjs: keep the stored "tenure" (per company) and "duration" (per role)
// text in content/profile.json equal to what the dates say.
//
// Usage:
//   node scripts/update-tenure.mjs            show what would change, change nothing
//   node scripts/update-tenure.mjs --write    rewrite the stale strings in place
//   node scripts/update-tenure.mjs --check    exit 1 if anything is stale (for CI / hooks)
//
// The page and the WebMCP tools already work these out from the dates every time
// they run (assets/js/tenure.js). The stored text exists for readers that only see the
// JSON, mostly Atlas, which fetches profile.json live. A monthly GitHub Action
// (.github/workflows/update-tenure.yml) runs this with --write on the 1st.
//
// Only the text between the quotes of those two fields is touched, so the file's
// formatting stays exactly as it is. Stdlib only, no npm install step.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { exit } from "node:process";
import { spanLabel, companyLabel } from "../assets/js/tenure.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = resolve(REPO_ROOT, "content/profile.json");

const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check");

const raw = await readFile(PROFILE, "utf8");
const profile = JSON.parse(raw);
const companies = Array.isArray(profile.experience) ? profile.experience : [];
const roleCount = companies.reduce((n, c) => n + (Array.isArray(c.roles) ? c.roles.length : 0), 0);

// Every tenure/duration string in the file, in document order. They line up one to one
// with the companies and roles in the parsed JSON; if they do not, stop rather than guess.
const TENURE_RE = /("tenure"\s*:\s*")([^"]*)(")/g;
const DURATION_RE = /("duration"\s*:\s*")([^"]*)(")/g;
const tenureHits = [...raw.matchAll(TENURE_RE)];
const durationHits = [...raw.matchAll(DURATION_RE)];
if (tenureHits.length !== companies.length || durationHits.length !== roleCount) {
    console.error(
        `Cannot line up the text with the data: ${tenureHits.length} tenure / ${durationHits.length} duration strings ` +
        `in the file, but ${companies.length} companies / ${roleCount} roles. Fix profile.json by hand first.`
    );
    exit(2);
}

const now = new Date();
const edits = []; // { index, length, text, note }

companies.forEach((co, i) => {
    const want = companyLabel(co, now);
    const hit = tenureHits[i];
    if (want && want !== hit[2]) {
        edits.push({
            index: hit.index + hit[1].length,
            length: hit[2].length,
            text: want,
            note: `${co.company} tenure: "${hit[2]}" -> "${want}"`,
        });
    }
});

let d = 0;
for (const co of companies) {
    for (const r of co.roles || []) {
        const want = spanLabel(r.start, r.end, now);
        const hit = durationHits[d++];
        if (want && want !== hit[2]) {
            edits.push({
                index: hit.index + hit[1].length,
                length: hit[2].length,
                text: want,
                note: `${co.company} / ${r.title}: "${hit[2]}" -> "${want}"`,
            });
        }
    }
}

if (!edits.length) {
    console.log("Tenure text is already up to date.");
    exit(0);
}

for (const e of edits) console.log(`${write ? "updated" : "stale"}  ${e.note}`);

if (write) {
    // Apply from the end so earlier offsets stay valid.
    let out = raw;
    for (const e of [...edits].sort((a, b) => b.index - a.index)) {
        out = out.slice(0, e.index) + e.text + out.slice(e.index + e.length);
    }
    JSON.parse(out); // never write a file that no longer parses
    await writeFile(PROFILE, out);
    console.log(`Wrote ${edits.length} change${edits.length === 1 ? "" : "s"} to content/profile.json.`);
    exit(0);
}

console.log(`\n${edits.length} stale. Run with --write to update.`);
exit(check ? 1 : 0);
