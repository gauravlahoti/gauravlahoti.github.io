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
const AGENT_LOG_TOKEN = process.env.AGENT_LOG_TOKEN || "";

const ALLOWED_ISS = new Set([
    "accounts.google.com",
    "https://accounts.google.com"
]);

// ---------- DB bootstrap ----------
const dbPath = path.join(__dirname, "leads.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
const schemaPath = path.join(__dirname, "schema.sql");
// schema.sql now contains ALTER TABLE statements for new columns (Spec #24).
// Run each statement separately — db.exec() halts on the first ALTER TABLE
// error (column already exists), which would skip subsequent statements.
const schemaSql = fs.readFileSync(schemaPath, "utf8");
for (const stmt of schemaSql.split(";").map(s => s.trim()).filter(Boolean)) {
    try { db.prepare(stmt).run(); } catch (_) { /* column already exists — safe to ignore */ }
}

const insertLead = db.prepare(
    `INSERT INTO resume_downloads
     (google_sub, email, email_verified, name, picture, downloaded_at, ip, user_agent, referrer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const recentLeads = db.prepare(
    `SELECT id, google_sub, email, email_verified, name, picture, downloaded_at, ip, user_agent, referrer
     FROM resume_downloads ORDER BY downloaded_at DESC LIMIT 200`
);
const recentForSub = db.prepare(
    `SELECT 1 FROM resume_downloads WHERE google_sub = ? AND downloaded_at > ? LIMIT 1`
);

const insertAgentInteraction = db.prepare(
    `INSERT INTO agent_interactions
       (session_id, turn_index, logged_at, question, response, tool_calls,
        tokens_input, tokens_output, latency_ms, status, error_message,
        google_sub, email, ip, user_agent, referrer, agent_version,
        citations_count, suggestions_count, cta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const recentAgentInteractions = db.prepare(
    `SELECT id, session_id, turn_index, logged_at, question, response, tool_calls,
            tokens_input, tokens_output, latency_ms, status, error_message,
            google_sub, email, ip, user_agent, referrer, agent_version,
            citations_count, suggestions_count, cta
     FROM agent_interactions ORDER BY logged_at DESC LIMIT 200`
);

const DEDUPE_WINDOW_SECONDS = 24 * 60 * 60;

// Mirror of the Worker's truncateIp (see backend/src/index.js). Keeps city-
// level geolocation, drops precise host identification.
function truncateIp(ip) {
    if (!ip) return "";
    if (ip.includes(":")) {
        const hextets = ip.split(":").filter(Boolean).slice(0, 4);
        return hextets.join(":") + "::x";
    }
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
    return "";
}

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

    // Dedupe per google_sub within 24h — same behaviour as the Worker.
    const cutoff = Math.floor(Date.now() / 1000) - DEDUPE_WINDOW_SECONDS;
    try {
        if (recentForSub.get(c.sub, cutoff)) {
            console.log(`[lead] dedupe — ${c.email} already recorded within 24h`);
            return sendJson(res, 200, { ok: true, url: "/assets/img/resume.pdf", deduped: true }, cors);
        }
    } catch (err) {
        console.warn("[dedupe] check failed", err);
        // Fall through and let the INSERT happen.
    }

    const ip = truncateIp(req.socket.remoteAddress || "");
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

// POST /api/agent-log — internal write endpoint called by Cloud Run after each agent turn.
// Auth: X-Internal-Token header must match AGENT_LOG_TOKEN env var (no CORS — browser never calls this).
// Self-asserted identity — see Spec #23 §Trust model. Do not add JWT verification here.
async function handleAgentLog(req, res) {
    if (!AGENT_LOG_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Agent log endpoint disabled" }, {});
    }
    if ((req.headers["x-internal-token"] || "") !== AGENT_LOG_TOKEN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, {});
    }
    let body;
    try { body = await readJson(req, 64 * 1024); }
    catch (_) { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }, {}); }

    const sessionId = body?.sessionId;
    const turnIndex = body?.turnIndex;
    const question  = body?.question;
    const status    = body?.status;
    const VALID_STATUSES = new Set(["ok", "error", "injection_blocked", "too_long", "rate_limited"]);

    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 64) {
        return sendJson(res, 400, { ok: false, error: "Invalid sessionId" }, {});
    }
    if (typeof turnIndex !== "number" || turnIndex < 0 || !Number.isInteger(turnIndex)) {
        return sendJson(res, 400, { ok: false, error: "Invalid turnIndex" }, {});
    }
    if (typeof question !== "string" || question.length < 1) {
        return sendJson(res, 400, { ok: false, error: "Invalid question" }, {});
    }
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
        return sendJson(res, 400, { ok: false, error: "Invalid status" }, {});
    }

    const response     = String(body?.response     ?? "").slice(0, 16000);
    const toolCallsRaw = body?.toolCalls;
    const toolCalls    = toolCallsRaw ? JSON.stringify(toolCallsRaw).slice(0, 8000) : null;
    const errorMessage = body?.errorMessage ? String(body.errorMessage).slice(0, 500) : null;
    const identity     = (body?.identity && typeof body.identity === "object") ? body.identity : {};
    const googleSub    = identity.sub   ? String(identity.sub).slice(0, 200)   : null;
    const email        = identity.email ? String(identity.email).slice(0, 200) : null;
    const ip           = truncateIp(String(body?.ip ?? ""));
    const userAgent    = String(body?.userAgent    ?? "").slice(0, 500);
    const referrer     = String(body?.referrer     ?? "").slice(0, 500);
    const agentVersion = String(body?.agentVersion ?? "").slice(0, 100);
    const tokensInput  = Number.isInteger(body?.tokensInput)  ? body.tokensInput  : null;
    const tokensOutput = Number.isInteger(body?.tokensOutput) ? body.tokensOutput : null;
    const latencyMs    = Number.isInteger(body?.latencyMs)    ? body.latencyMs    : null;
    const loggedAt     = Math.floor(Date.now() / 1000);
    // Spec #24 — meta-block fields
    const citationsCount   = Number.isInteger(body?.citationsCount)   ? body.citationsCount   : null;
    const suggestionsCount = Number.isInteger(body?.suggestionsCount) ? body.suggestionsCount : null;
    const cta = (body?.cta === "topmate" || body?.cta === "linkedin") ? body.cta : null;

    try {
        const result = insertAgentInteraction.run(
            sessionId, turnIndex, loggedAt,
            question.slice(0, 4000), response, toolCalls,
            tokensInput, tokensOutput, latencyMs,
            status, errorMessage,
            googleSub, email, ip, userAgent, referrer, agentVersion,
            citationsCount, suggestionsCount, cta
        );
        console.log(`[agent-log] session=${sessionId} turn=${turnIndex} status=${status}`);
        sendJson(res, 200, { ok: true, id: result.lastInsertRowid }, {});
    } catch (err) {
        console.error("[agent-log] insert failed", err);
        sendJson(res, 500, { ok: false, error: "Internal" }, {});
    }
}

// GET /api/agent-log — admin dump of recent agent interactions.
// Reuses ADMIN_TOKEN from spec #11 (no new credential to manage).
function handleAgentLogRead(req, res, cors) {
    if (!ADMIN_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Admin endpoint disabled (set ADMIN_TOKEN)" }, cors);
    }
    if ((req.headers.authorization || "") !== `Bearer ${ADMIN_TOKEN}`) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, cors);
    }
    sendJson(res, 200, { ok: true, leads: recentAgentInteractions.all() }, cors);
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
    if (url.pathname === "/api/agent-log" && req.method === "POST") {
        return handleAgentLog(req, res);
    }
    if (url.pathname === "/api/agent-log" && req.method === "GET") {
        return handleAgentLogRead(req, res, cors);
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
