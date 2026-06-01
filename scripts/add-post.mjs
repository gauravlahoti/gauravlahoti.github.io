#!/usr/bin/env node
// add-post.mjs — append a LinkedIn post to content/posts.json.
// Usage: node scripts/add-post.mjs <linkedin-post-url>
//
// Fetches the post's OpenGraph meta with a crawler User-Agent, derives a
// firstLine + excerpt, prompts for confirmation (Y / n / edit), and prepends
// the entry to posts.json. Stdlib only — no npm install step.

import { readFile, writeFile, rename, mkdtemp, unlink, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve, join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = pathResolve(SCRIPT_DIR, "..");
const POSTS_PATH = pathResolve(REPO_ROOT, "content/posts.json");

const URL_RE = /^https?:\/\/(?:www\.)?linkedin\.com\/(?:posts\/|feed\/update\/)/i;
const CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const FETCH_TIMEOUT_MS = 15_000;
const FIRST_LINE_MAX = 120;

async function main() {
    const args = process.argv.slice(2);
    const printOnly = args.includes("--print");
    const url = args.find(a => !a.startsWith("--"));

    if (!url) {
        printUsage();
        exit(2);
    }
    if (!URL_RE.test(url)) {
        console.error("✗ Not a recognised LinkedIn post URL.");
        console.error("  Expected: https://www.linkedin.com/posts/...  or  /feed/update/...");
        exit(2);
    }

    const posts = await loadPosts();

    const existing = posts.find(p => p.url === url);
    if (existing) {
        if (printOnly) {
            console.error(`DUPLICATE firstLine="${existing.firstLine}"`);
            exit(3);
        }
        console.log(`✓ Already in posts.json (firstLine: "${existing.firstLine}").`);
        console.log("  No changes made.");
        exit(0);
    }

    const fetched = await tryFetchOg(url);

    let entry;
    if (fetched) {
        const desc = (fetched.description || "").trim();
        const tags = deriveTagsFromUrl(url);
        const textTags = extractTagsFromText(desc);
        entry = {
            url,
            firstLine: deriveFirstLine(desc || fetched.title || ""),
            excerpt:   desc,
            date:      deriveDateFromUrl(url) || todayIso(),
            tags:      textTags.length ? textTags : tags,
        };
    } else if (printOnly) {
        console.error("FETCH_FAILED could not retrieve OG metadata");
        exit(4);
    } else {
        console.warn("! Couldn't fetch OG metadata. Falling into manual entry.");
        entry = await manualEntry(url);
        if (!entry) {
            console.log("Cancelled. No changes made.");
            exit(1);
        }
        entry.tags = deriveTagsFromUrl(url);
    }

    if (printOnly) {
        // Emit clean JSON only on stdout — slash command parses it directly.
        process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
        exit(0);
    }

    entry = await confirmOrEdit(entry);
    if (!entry) {
        console.log("Cancelled. No changes made.");
        exit(1);
    }

    posts.unshift(entry);
    await atomicWriteJson(POSTS_PATH, posts);

    console.log("✓ Added to content/posts.json:");
    console.log(JSON.stringify(entry, null, 2));
    console.log("\n  Review with `git diff content/posts.json`, then commit.");
}

function printUsage() {
    console.error("Usage: node scripts/add-post.mjs <linkedin-post-url> [--print]");
    console.error("");
    console.error("  --print   Fetch + parse and emit the parsed entry as JSON on stdout,");
    console.error("            no write, no prompts. Exit codes: 0 ok, 2 bad URL,");
    console.error("            3 already in posts.json, 4 OG fetch failed.");
    console.error("");
    console.error("Example:");
    console.error("  node scripts/add-post.mjs https://www.linkedin.com/posts/glahoti_<slug>");
}

async function loadPosts() {
    try {
        await stat(POSTS_PATH);
    } catch {
        return [];
    }
    const raw = await readFile(POSTS_PATH, "utf8");
    if (!raw.trim()) return [];
    try {
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error(`✗ ${POSTS_PATH} is not valid JSON. Aborting.`);
        console.error(`  ${err.message}`);
        exit(2);
    }
}

async function tryFetchOg(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: "follow",
            headers: {
                "User-Agent": CRAWLER_UA,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en",
            },
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            console.warn(`  HTTP ${res.status} from LinkedIn.`);
            return null;
        }
        const html = await res.text();
        const title       = pickMeta(html, "og:title");
        const description = pickMeta(html, "og:description");
        if (!description && !title) return null;
        return { title, description };
    } catch (err) {
        clearTimeout(timer);
        console.warn(`  Fetch failed: ${err.message}`);
        return null;
    }
}

// Locate <meta property="og:..." content="..."> tolerantly across attribute
// order and quote style. The previous mixed character class `[^"']*` stopped
// at *either* quote OR apostrophe — so a description like
//   content="I built ... so you don't have to."
// got truncated at the apostrophe in "don't". Match double-quoted and
// single-quoted content= attributes separately so literal apostrophes inside
// double-quoted values (and quotes inside single-quoted ones) pass through.
function pickMeta(html, prop) {
    const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
        new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content="([^"]*)"`, "i"),
        new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content='([^']*)'`, "i"),
        new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property=["']${escaped}["']`, "i"),
        new RegExp(`<meta[^>]+content='([^']*)'[^>]+property=["']${escaped}["']`, "i"),
        new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content="([^"]*)"`, "i"),
        new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content='([^']*)'`, "i"),
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) return collapseWhitespace(decodeEntities(m[1]));
    }
    return "";
}

// LinkedIn's og:description occasionally arrives with long runs of U+00A0
// (non-breaking space) used as visual padding. Collapse any whitespace run
// — including nbsp and zero-width chars — to a single regular space, while
// preserving paragraph breaks (\n\n).
function collapseWhitespace(s) {
    return s
        .replace(/[​-‍﻿]/g, "")          // zero-width junk
        .replace(/[ \t ]+/g, " ")                  // horizontal ws → single space
        .replace(/ *\n */g, "\n")                       // trim spaces around newlines
        .replace(/\n{3,}/g, "\n\n")                     // cap blank lines at one
        .trim();
}

function decodeEntities(s) {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

function deriveFirstLine(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return "";
    // Prefer first newline; else first sentence boundary; else hard truncate.
    const nlIdx = trimmed.search(/[\r\n]/);
    let line = nlIdx > 0 ? trimmed.slice(0, nlIdx) : trimmed;
    const sentMatch = line.match(/^.*?[.!?](?=\s|$)/);
    if (sentMatch && sentMatch[0].length >= 16) {
        line = sentMatch[0];
    }
    line = line.trim();
    if (line.length <= FIRST_LINE_MAX) return line;
    // Truncate on word boundary, no trailing ellipsis (cleaner heading).
    const cut = line.slice(0, FIRST_LINE_MAX);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:—-]+$/, "");
}

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

// LinkedIn activity URNs are snowflake-style: the high 41 bits encode
// milliseconds since Unix epoch, shifted left by 22. Reverse the shift to
// recover the actual publish date — far more accurate than defaulting to
// "today the user happened to add it." Returns null if the URL doesn't
// contain a recognisable activity ID or the decoded date is implausible.
// Extract hashtags from the URL slug: /posts/USERNAME_TAG1-TAG2-TAG3-ugcPost-ID
// LinkedIn encodes the post's first 2–3 hashtags in the URL slug, making this
// a reliable source even when the OG description is truncated.
function deriveTagsFromUrl(url) {
    const m = url && url.match(/\/posts\/[^_]+_(.+?)-(?:ugcPost|share)-/i);
    if (!m) return [];
    return m[1].split("-").filter(t => t.length > 1);
}

// Extract #hashtag tokens from post body text (OG description).
// Preferred over URL slug when available — gives all hashtags, not just the first few.
function extractTagsFromText(text) {
    const seen = new Set();
    return (text.match(/#(\w+)/g) || [])
        .map(t => t.slice(1).toLowerCase())
        .filter(t => seen.has(t) ? false : seen.add(t));
}

function deriveDateFromUrl(url) {
    const m = url && url.match(/(\d{15,21})/);
    if (!m) return null;
    try {
        const ms = Number(BigInt(m[1]) >> 22n);
        const d = new Date(ms);
        const y = d.getUTCFullYear();
        if (Number.isNaN(d.getTime()) || y < 2010 || y > 2100) return null;
        return d.toISOString().slice(0, 10);
    } catch {
        return null;
    }
}

async function manualEntry(url) {
    const rl = createInterface({ input, output });
    try {
        console.log("\nManual entry — leave blank to abort.");
        const firstLine = (await rl.question("First line: ")).trim();
        if (!firstLine) return null;
        const excerpt = (await rl.question("Excerpt (optional): ")).trim();
        const defaultDate = deriveDateFromUrl(url) || todayIso();
        const dateInput = (await rl.question(`Date [${defaultDate}]: `)).trim();
        const date = dateInput || defaultDate;
        return { url, firstLine, excerpt, date };
    } finally {
        rl.close();
    }
}

async function confirmOrEdit(entry) {
    const rl = createInterface({ input, output });
    try {
        while (true) {
            console.log("\nParsed entry:");
            console.log(JSON.stringify(entry, null, 2));
            const ans = (await rl.question("Append? [Y/n/edit]: ")).trim().toLowerCase();
            if (ans === "" || ans === "y" || ans === "yes") return entry;
            if (ans === "n" || ans === "no") return null;
            if (ans === "e" || ans === "edit") {
                rl.close();
                const edited = await editInExternalEditor(entry);
                if (!edited) return null;
                // Re-open readline for any subsequent loop iteration.
                return await confirmOrEditEdited(edited);
            }
            console.log("  (please answer y, n, or edit)");
        }
    } finally {
        rl.close();
    }
}

async function confirmOrEditEdited(entry) {
    const rl = createInterface({ input, output });
    try {
        console.log("\nEdited entry:");
        console.log(JSON.stringify(entry, null, 2));
        const ans = (await rl.question("Append? [Y/n]: ")).trim().toLowerCase();
        if (ans === "" || ans === "y" || ans === "yes") return entry;
        return null;
    } finally {
        rl.close();
    }
}

async function editInExternalEditor(entry) {
    const editor = process.env.EDITOR || process.env.VISUAL || "vi";
    const dir = await mkdtemp(join(tmpdir(), "add-post-"));
    const file = join(dir, "post.json");
    await writeFile(file, JSON.stringify(entry, null, 2) + "\n", "utf8");
    const code = await runEditor(editor, file);
    if (code !== 0) {
        console.warn(`  Editor exited with code ${code}; abandoning edit.`);
        await unlink(file).catch(() => {});
        return null;
    }
    let edited;
    try {
        const raw = await readFile(file, "utf8");
        edited = JSON.parse(raw);
    } catch (err) {
        console.error(`  Edited file isn't valid JSON: ${err.message}. Abandoning edit.`);
        await unlink(file).catch(() => {});
        return null;
    } finally {
        await unlink(file).catch(() => {});
    }
    if (!edited || typeof edited.url !== "string" || typeof edited.firstLine !== "string") {
        console.error("  Edited entry is missing 'url' or 'firstLine'. Abandoning edit.");
        return null;
    }
    return edited;
}

function runEditor(editor, file) {
    return new Promise((res) => {
        const child = spawn(editor, [file], { stdio: "inherit" });
        child.on("exit", (code) => res(code ?? 1));
        child.on("error", () => res(1));
    });
}

async function atomicWriteJson(target, data) {
    const tmp = `${target}.tmp`;
    const body = JSON.stringify(data, null, 2) + "\n";
    await writeFile(tmp, body, "utf8");
    await rename(tmp, target);
}

main().catch((err) => {
    console.error("✗ Unexpected error:", err);
    exit(2);
});
