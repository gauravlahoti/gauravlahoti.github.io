#!/usr/bin/env node
// refresh-build-stats.mjs — recompute the `stats` block in content/build-story.json.
// Usage: node scripts/refresh-build-stats.mjs [--print]
//
// The build story quotes real counts (commits, specs, skills). Those decay the
// moment anything ships, and a stale number in an agent's mouth is worse than
// no number, so this recounts them from the repo and rewrites just the `stats`
// object. Everything else in the file is hand-written and left alone.
//
// Run it manually before a deploy that touches the build story. Deliberately
// NOT wired into /publish — a content edit shouldn't silently rewrite prose
// the agent cites. Stdlib only, no npm install step.

import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const run = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(SCRIPT_DIR, "..");
const STORY_PATH = pathResolve(REPO_ROOT, "content/build-story.json");

async function git(...args) {
    const { stdout } = await run("git", args, { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
}

const countLines = (s) => s.split("\n").filter(Boolean).length;

async function countEntries(relDir, predicate) {
    const entries = await readdir(pathResolve(REPO_ROOT, relDir), { withFileTypes: true });
    return entries.filter(predicate).length;
}

async function main() {
    const printOnly = process.argv.includes("--print");

    const [log, claudeLog, firstDate] = await Promise.all([
        git("log", "--oneline"),
        git("log", "--oneline", "-i", "--grep=claude"),
        git("log", "--format=%ad", "--date=short"),
    ]);

    // find is not available as a promise API here; walk the known CLAUDE.md homes.
    const claudeMd = await git("ls-files", "CLAUDE.md", "*/CLAUDE.md", "**/CLAUDE.md");

    const stats = {
        asOf: new Date().toISOString().slice(0, 10),
        startedOn: firstDate.trim().split("\n").pop().trim(),
        commits: countLines(log),
        claudeCoAuthored: countLines(claudeLog),
        specs: await countEntries(".claude/specs", (e) => e.isFile() && e.name.endsWith(".md")),
        skills: await countEntries(".claude/skills", (e) => e.isDirectory()),
        slashCommands: await countEntries(".claude/commands", (e) => e.isFile() && e.name.endsWith(".md")),
        subagents: await countEntries(".claude/agents", (e) => e.isFile() && e.name.endsWith(".md")),
        claudeMdFiles: countLines(claudeMd),
        buildSteps: 0,
        npmDependencies: 0,
    };

    const story = JSON.parse(await readFile(STORY_PATH, "utf8"));
    const before = story.stats ?? {};
    story.stats = stats;

    const changed = Object.keys(stats).filter((k) => before[k] !== stats[k]);
    if (!changed.length) {
        console.log("build-story stats already current — nothing to write.");
        return;
    }

    for (const k of changed) console.log(`  ${k}: ${before[k]} → ${stats[k]}`);

    if (printOnly) {
        console.log("\n--print: not written.");
        return;
    }

    await writeFile(STORY_PATH, JSON.stringify(story, null, 2) + "\n", "utf8");
    console.log(`\nWrote ${STORY_PATH}`);
    console.log("Remember: cd agents/atlas && make corpus");
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
