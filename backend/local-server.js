// local-server.js — local-only resume gate backend.
// Same protocol as the Cloudflare Worker (src/index.js) but writes to a
// SQLite file on disk via better-sqlite3. Used while developing the
// portfolio without provisioning Cloudflare.
//
//   node backend/local-server.js
//   → listens on http://localhost:8787
//   → DB file at backend/leads.db (auto-created from schema.sql)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
    "http://localhost:5173,http://127.0.0.1:5173"
).split(",").map(s => s.trim()).filter(Boolean);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ||
    "593919045544-0rl59vv2rfqh3t5gi7fq7c1set1rn0pa.apps.googleusercontent.com";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const ALLOWED_ISS = new Set([
    "accounts.google.com",
    "https://accounts.google.com"
]);

// ---------- DB bootstrap ----------
const dbPath = path.join(__dirname, "leads.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
const schemaPath = path.join(__dirname, "schema.sql");
db.exec(fs.readFileSync(schemaPath, "utf8"));

const insertLead = db.prepare(
    `INSERT INTO resume_downloads
     (google_sub, email, email_verified, name, picture, downloaded_at, ip, user_agent, referrer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const recentLeads = db.prepare(
    `SELECT id, google_sub, email, email_verified, name, picture, downloaded_at, ip, user_agent, referrer
     FROM resume_downloads ORDER BY downloaded_at DESC LIMIT 200`
);

// ---------- helpers ----------
function buildCors(origin) {
    const headers = {
        Vary: "Origin",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400"
    };
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
    }
    return headers;
}

function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...extraHeaders
    });
    res.end(payload);
}

async function readJson(req, limit = 8 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > limit) {
                req.destroy();
                reject(new Error("Body too large"));
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
            } catch (err) { reject(err); }
        });
        req.on("error", reject);
    });
}

async function verifyGoogleIdToken(credential) {
    if (typeof credential !== "string" || credential.length < 20 || credential.length > 4096) {
        return { ok: false, status: 400, error: "Invalid credential" };
    }
    let res;
    try {
        res = await fetch(
            "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)
        );
    } catch (_) {
        return { ok: false, status: 502, error: "Verification upstream unreachable" };
    }
    if (!res.ok) return { ok: false, status: 401, error: "Token verification failed" };
    let claims;
    try { claims = await res.json(); }
    catch (_) { return { ok: false, status: 401, error: "Token verification failed" }; }
    if (!claims || claims.error || claims.error_description) {
        return { ok: false, status: 401, error: "Token verification failed" };
    }
    if (!GOOGLE_CLIENT_ID || claims.aud !== GOOGLE_CLIENT_ID) {
        return { ok: false, status: 401, error: "Audience mismatch" };
    }
    if (!ALLOWED_ISS.has(claims.iss)) {
        return { ok: false, status: 401, error: "Issuer mismatch" };
    }
    if (Number(claims.exp) <= Math.floor(Date.now() / 1000)) {
        return { ok: false, status: 401, error: "Token expired" };
    }
    if (claims.email_verified !== "true" && claims.email_verified !== true) {
        return { ok: false, status: 401, error: "Email not verified" };
    }
    if (!claims.sub || !claims.email) {
        return { ok: false, status: 401, error: "Missing required claims" };
    }
    return { ok: true, claims };
}

// ---------- handlers ----------
async function handleDownload(req, res, origin, cors) {
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        return sendJson(res, 403, { ok: false, error: "Origin not allowed" }, cors);
    }
    let body;
    try { body = await readJson(req); }
    catch (_) { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }, cors); }

    const v = await verifyGoogleIdToken(body?.credential);
    if (!v.ok) return sendJson(res, v.status, { ok: false, error: v.error }, cors);
    const c = v.claims;

    const ip = req.socket.remoteAddress || "";
    const ua = (req.headers["user-agent"] || "").slice(0, 500);
    const referrer = (req.headers.referer || "").slice(0, 500);
    const at = Math.floor(Date.now() / 1000);
    const name = String(c.name || c.given_name || "").slice(0, 200);
    const email = String(c.email).slice(0, 200);
    const picture = String(c.picture || "").slice(0, 500);

    try {
        insertLead.run(c.sub, email, 1, name, picture, at, ip, ua, referrer);
    } catch (err) {
        console.error("[lead-insert]", err);
        return sendJson(res, 500, { ok: false, error: "Internal" }, cors);
    }
    console.log(`[lead] ${name} <${email}>`);
    sendJson(res, 200, { ok: true, url: "/assets/img/resume.pdf" }, cors);
}

function handleLeads(req, res, cors) {
    if (!ADMIN_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Admin endpoint disabled (set ADMIN_TOKEN)" }, cors);
    }
    if ((req.headers.authorization || "") !== `Bearer ${ADMIN_TOKEN}`) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, cors);
    }
    sendJson(res, 200, { ok: true, leads: recentLeads.all() }, cors);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || "";
    const cors = buildCors(origin);

    if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
    }
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/api/resume-download" && req.method === "POST") {
        return handleDownload(req, res, origin, cors);
    }
    if (url.pathname === "/api/leads" && req.method === "GET") {
        return handleLeads(req, res, cors);
    }
    if (url.pathname === "/health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, db: dbPath }, cors);
    }
    sendJson(res, 404, { ok: false, error: "Not found" }, cors);
});

server.listen(PORT, () => {
    console.log(`[resume-gate] listening http://localhost:${PORT}`);
    console.log(`[resume-gate] db = ${dbPath}`);
    console.log(`[resume-gate] origins = ${ALLOWED_ORIGINS.join(", ")}`);
});
