#!/usr/bin/env node
// generate-engineering-loops-narration.mjs — render the Engineering Loops narration
// lines to voice audio via ElevenLabs, once, as a content-authoring step.
//
// Usage:
//   ELEVENLABS_API_KEY=sk_... node scripts/generate-engineering-loops-narration.mjs
//   node scripts/generate-engineering-loops-narration.mjs --layer=context --dry-run
//   node scripts/generate-engineering-loops-narration.mjs --layer=context --force
//
// Reads content/engineering-loops.json, walks layers[].narration[], and writes one
// mp3 per line to assets/audio/engineering-loops/<layerId>-<NN>.mp3 (1-based, zero-
// padded 2 — the convention the playback engine derives filenames from). Runs
// manually/locally, never at build or request time. Stdlib only — no npm install.
//
// Flags:
//   --layer=<id>   only render that layer (prompt | context | harness | loop)
//   --force        overwrite existing mp3s (default: skip files already present)
//   --dry-run      print what would be rendered/written, call no API, write nothing
//
// Env:
//   ELEVENLABS_API_KEY   required (unless --dry-run)
//   ELEVENLABS_VOICE_ID  optional, defaults to Rachel (21m00Tcm4TlvDq8ikWAM)
//   ELEVENLABS_MODEL_ID  optional, defaults to eleven_multilingual_v2

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import { exit } from "node:process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(SCRIPT_DIR, "..");
const CONTENT_PATH = pathResolve(REPO_ROOT, "content/engineering-loops.json");
const AUDIO_DIR = pathResolve(REPO_ROOT, "assets/audio/engineering-loops");

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
const OUTPUT_FORMAT = "mp3_44100_128";
const FETCH_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
    const opts = { layer: null, force: false, dryRun: false };
    for (const a of argv) {
        if (a === "--force") opts.force = true;
        else if (a === "--dry-run") opts.dryRun = true;
        else if (a.startsWith("--layer=")) opts.layer = a.slice("--layer=".length).trim();
        else {
            console.error(`✗ Unknown argument: ${a}`);
            printUsage();
            exit(2);
        }
    }
    return opts;
}

function printUsage() {
    console.error("Usage: ELEVENLABS_API_KEY=... node scripts/generate-engineering-loops-narration.mjs [--layer=<id>] [--force] [--dry-run]");
}

function fileName(layerId, i) {
    return `${layerId}-${String(i + 1).padStart(2, "0")}.mp3`;
}

async function exists(path) {
    try { await stat(path); return true; } catch { return false; }
}

async function synthesize(apiKey, text) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "xi-api-key": apiKey,
                "content-type": "application/json",
                accept: "audio/mpeg",
            },
            body: JSON.stringify({
                text,
                model_id: MODEL_ID,
                voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
            }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`ElevenLabs ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
        }
        return Buffer.from(await res.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    const content = JSON.parse(await readFile(CONTENT_PATH, "utf8"));
    let layers = (content.layers || []).filter(l => l.narration?.length);
    if (opts.layer) {
        layers = layers.filter(l => l.id === opts.layer);
        if (!layers.length) {
            console.error(`✗ No layer "${opts.layer}" with narration in ${CONTENT_PATH}`);
            exit(2);
        }
    }
    if (!layers.length) {
        console.error("✗ No layers with a narration[] array found.");
        exit(1);
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey && !opts.dryRun) {
        console.error("✗ ELEVENLABS_API_KEY is not set. Export it, or pass --dry-run to preview.");
        exit(2);
    }

    if (!opts.dryRun) await mkdir(AUDIO_DIR, { recursive: true });

    let rendered = 0, skipped = 0, failed = 0;
    for (const layer of layers) {
        for (let i = 0; i < layer.narration.length; i++) {
            const text = (layer.narration[i].text || "").trim();
            const name = fileName(layer.id, i);
            const outPath = pathResolve(AUDIO_DIR, name);

            if (!text) {
                console.warn(`⚠ ${name}: empty text, skipping`);
                skipped++;
                continue;
            }
            if (!opts.force && await exists(outPath)) {
                console.log(`• ${name}: exists, skipping (use --force to overwrite)`);
                skipped++;
                continue;
            }
            if (opts.dryRun) {
                console.log(`○ ${name}: would render "${text}"`);
                rendered++;
                continue;
            }

            try {
                const audio = await synthesize(apiKey, text);
                await writeFile(outPath, audio);
                console.log(`✓ ${name}: ${audio.length} bytes`);
                rendered++;
            } catch (err) {
                console.error(`✗ ${name}: ${err.message}`);
                failed++;
            }
        }
    }

    console.log(`\n${opts.dryRun ? "[dry-run] " : ""}rendered ${rendered}, skipped ${skipped}, failed ${failed}`);
    if (failed) exit(1);
}

main().catch(err => {
    console.error("✗ Fatal:", err.message);
    exit(1);
});
