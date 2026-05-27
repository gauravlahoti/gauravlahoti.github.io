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
import { createHash } from "node:crypto";
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
        citations_count, suggestions_count, cta,
        country, region, city)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const recentAgentInteractions = db.prepare(
    `SELECT id, session_id, turn_index, logged_at, question, response, tool_calls,
            tokens_input, tokens_output, latency_ms, status, error_message,
            google_sub, email, ip, user_agent, referrer, agent_version,
            citations_count, suggestions_count, cta,
            country, region, city
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
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Internal-Token",
        "Access-Control-Allow-Private-Network": "true",
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
    const geoStr = (v) => {
        if (typeof v !== "string") return null;
        const s = v.slice(0, 64).trim();
        return s.length ? s : null;
    };
    const country = geoStr(body?.country);
    const region  = geoStr(body?.region);
    const city    = geoStr(body?.city);

    try {
        const result = insertAgentInteraction.run(
            sessionId, turnIndex, loggedAt,
            question.slice(0, 4000), response, toolCalls,
            tokensInput, tokensOutput, latencyMs,
            status, errorMessage,
            googleSub, email, ip, userAgent, referrer, agentVersion,
            citationsCount, suggestionsCount, cta,
            country, region, city
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

// Per-recipient rate-limit gate for the agent's send_resume tool. Mirrors
// handleResumeSendCheck / handleResumeSendRecord in src/index.js.
const RESUME_SEND_WINDOW_SECONDS = 24 * 60 * 60;
const recentResumeSendForHash = db.prepare(
    "SELECT 1 FROM resume_sends WHERE email_hash = ? AND sent_at > ? LIMIT 1"
);
const insertResumeSend = db.prepare(
    "INSERT INTO resume_sends (email_hash, sent_at) VALUES (?, ?)"
);

async function handleResumeSendCheck(req, res) {
    if (!AGENT_LOG_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Endpoint disabled" }, {});
    }
    if ((req.headers["x-internal-token"] || "") !== AGENT_LOG_TOKEN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, {});
    }
    let body;
    try { body = await readJson(req, 4 * 1024); }
    catch (_) { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }, {}); }
    const emailHash = body?.emailHash;
    if (typeof emailHash !== "string" || emailHash.length < 8 || emailHash.length > 64) {
        return sendJson(res, 400, { ok: false, error: "Invalid emailHash" }, {});
    }
    const cutoff = Math.floor(Date.now() / 1000) - RESUME_SEND_WINDOW_SECONDS;
    const hit = recentResumeSendForHash.get(emailHash, cutoff);
    sendJson(res, 200, { ok: true, allowed: !hit }, {});
}

async function handleResumeSendRecord(req, res) {
    if (!AGENT_LOG_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Endpoint disabled" }, {});
    }
    if ((req.headers["x-internal-token"] || "") !== AGENT_LOG_TOKEN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, {});
    }
    let body;
    try { body = await readJson(req, 4 * 1024); }
    catch (_) { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }, {}); }
    const emailHash = body?.emailHash;
    if (typeof emailHash !== "string" || emailHash.length < 8 || emailHash.length > 64) {
        return sendJson(res, 400, { ok: false, error: "Invalid emailHash" }, {});
    }
    const sentAt = Math.floor(Date.now() / 1000);
    const result = insertResumeSend.run(emailHash, sentAt);
    sendJson(res, 200, { ok: true, id: result.lastInsertRowid }, {});
}

// ---------- ambient agent D1 endpoints (Spec #31) ----------
// The ambient agent runs on Cloud Run (ADK); these are the thin D1 reads/writes
// it calls, gated by X-Internal-Token === AGENT_LOG_TOKEN. Mirror of the three
// handlers in src/index.js so the flow can be exercised locally.
const ambientInteractions = db.prepare(
    `SELECT question, response, status, country, city, logged_at
     FROM agent_interactions WHERE logged_at > ?
     ORDER BY logged_at DESC LIMIT 100`
);
const ambientLeads = db.prepare(
    `SELECT id, email, name, downloaded_at
     FROM resume_downloads
     WHERE followup_sent_at IS NULL AND downloaded_at < ?
     ORDER BY downloaded_at DESC LIMIT 25`
);

function handleAmbientInteractions(req, res, url) {
    if (!AGENT_LOG_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Endpoint disabled" }, {});
    }
    if ((req.headers["x-internal-token"] || "") !== AGENT_LOG_TOKEN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, {});
    }
    let days = parseInt(url.searchParams.get("days") || "3", 10);
    if (!Number.isFinite(days)) days = 3;
    days = Math.max(1, Math.min(30, days));
    const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    sendJson(res, 200, { ok: true, interactions: ambientInteractions.all(cutoff) }, {});
}

function handleAmbientLeads(req, res) {
    if (!AGENT_LOG_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Endpoint disabled" }, {});
    }
    if ((req.headers["x-internal-token"] || "") !== AGENT_LOG_TOKEN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, {});
    }
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    sendJson(res, 200, { ok: true, leads: ambientLeads.all(cutoff) }, {});
}

async function handleAmbientLeadsMark(req, res) {
    if (!AGENT_LOG_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Endpoint disabled" }, {});
    }
    if ((req.headers["x-internal-token"] || "") !== AGENT_LOG_TOKEN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, {});
    }
    let body;
    try { body = await readJson(req, 4 * 1024); }
    catch (_) { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }, {}); }
    const rawIds = Array.isArray(body?.ids) ? body.ids : null;
    if (!rawIds) {
        return sendJson(res, 400, { ok: false, error: "ids must be an array" }, {});
    }
    const ids = rawIds.filter(n => Number.isInteger(n) && n > 0).slice(0, 25);
    if (!ids.length) {
        return sendJson(res, 200, { ok: true, marked: 0 }, {});
    }
    const placeholders = ids.map(() => "?").join(",");
    const sentAt = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
        `UPDATE resume_downloads SET followup_sent_at = ? WHERE id IN (${placeholders})`
    );
    const result = stmt.run(sentAt, ...ids);
    sendJson(res, 200, { ok: true, marked: result.changes }, {});
}

// ---------- pageview beacon + stats (Spec #33) ----------
const BOT_UA_RE = /bot|crawl|spider|slurp|preview|monitor|lighthouse|headless|curl|wget|python-requests|axios|go-http/i;

const insertPageView = db.prepare(
    `INSERT INTO page_views (viewed_at, path, referrer, country, region, city, visitor_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
);

// Aggregate helpers mirror handleAmbientStats in src/index.js. Each is a
// single-value COUNT so the local SQLite path stays simple and readable.
const pvCountSince   = db.prepare(`SELECT COUNT(*) AS n FROM page_views WHERE viewed_at > ?`);
const pvCountBetween = db.prepare(`SELECT COUNT(*) AS n FROM page_views WHERE viewed_at > ? AND viewed_at <= ?`);
const pvUniqSince    = db.prepare(`SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at > ?`);
const pvUniqBetween  = db.prepare(`SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at > ? AND viewed_at <= ?`);
const pvCountAll     = db.prepare(`SELECT COUNT(*) AS n FROM page_views`);
const pvUniqAll      = db.prepare(`SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views`);
const dlCountAll     = db.prepare(`SELECT COUNT(*) AS n FROM resume_downloads`);
const dlCountSince   = db.prepare(`SELECT COUNT(*) AS n FROM resume_downloads WHERE downloaded_at > ?`);
const dlCountBetween = db.prepare(`SELECT COUNT(*) AS n FROM resume_downloads WHERE downloaded_at > ? AND downloaded_at <= ?`);
const convAll        = db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM agent_interactions`);
const convSince      = db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM agent_interactions WHERE logged_at > ?`);
const turnsSince     = db.prepare(`SELECT COUNT(*) AS n FROM agent_interactions WHERE logged_at > ?`);
const errSince       = db.prepare(`SELECT COUNT(*) AS n FROM agent_interactions WHERE logged_at > ? AND status != 'ok'`);
const topQStmt = db.prepare(
    `SELECT question, COUNT(*) AS count FROM agent_interactions
     WHERE logged_at > ? AND question != '' GROUP BY question
     ORDER BY count DESC, MAX(logged_at) DESC LIMIT 10`
);
const geoStmt = db.prepare(
    `SELECT country, city, COUNT(*) AS count FROM page_views
     WHERE viewed_at > ? AND country IS NOT NULL AND country != ''
     GROUP BY country, city ORDER BY count DESC LIMIT 8`
);
const errStmt = db.prepare(
    `SELECT question, status, error_message, logged_at FROM agent_interactions
     WHERE logged_at > ? AND status != 'ok' ORDER BY logged_at DESC LIMIT 8`
);

// Spec #34 — post_metrics prepared statements
const getPostMetrics = db.prepare(
    `SELECT post_id, reactions, comments, reposts, fetched_at FROM post_metrics`
);
const upsertPostMetric = db.prepare(
    `INSERT INTO post_metrics (post_id, urn_type, reactions, comments, reposts, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id) DO UPDATE SET
       urn_type   = excluded.urn_type,
       reactions  = COALESCE(excluded.reactions, post_metrics.reactions),
       comments   = COALESCE(excluded.comments,  post_metrics.comments),
       reposts    = COALESCE(excluded.reposts,   post_metrics.reposts),
       fetched_at = excluded.fetched_at`
);

async function handlePageview(req, res, origin, cors) {
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        res.writeHead(204, cors); return res.end();
    }
    const ua = req.headers["user-agent"] || "";
    if (!ua || BOT_UA_RE.test(ua)) { res.writeHead(204, cors); return res.end(); }

    let body = {};
    try { body = await readJson(req, 4 * 1024); } catch (_) { body = {}; }
    const path = String(body?.path || "/").slice(0, 256);
    let referrer = "";
    try {
        const ref = String(body?.referrer || "");
        referrer = ref ? new URL(ref).hostname.slice(0, 128) : "";
    } catch (_) { referrer = ""; }

    // No request.cf locally — geo is null; visitor_hash from remote address.
    const ip = req.socket?.remoteAddress || "";
    const utcDate = new Date().toISOString().slice(0, 10);
    const visitorHash = ip
        ? createHash("sha256").update(`${ip}|${ua}|${utcDate}`).digest("hex").slice(0, 16)
        : null;
    const at = Math.floor(Date.now() / 1000);
    try {
        insertPageView.run(at, path, referrer || null, null, null, null, visitorHash);
    } catch (err) { console.error("[pageview] insert failed", err.message); }
    res.writeHead(204, cors); res.end();
}

function handleAmbientStats(req, res, url) {
    if (!AGENT_LOG_TOKEN) return sendJson(res, 503, { ok: false, error: "Endpoint disabled" }, {});
    if ((req.headers["x-internal-token"] || "") !== AGENT_LOG_TOKEN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, {});
    }
    let days = parseInt(url.searchParams.get("days") || "4", 10);
    if (!Number.isFinite(days)) days = 4;
    days = Math.max(1, Math.min(30, days));
    const now = Math.floor(Date.now() / 1000);
    const winSecs = days * 24 * 60 * 60;
    const winStart = now - winSecs;
    const prevStart = now - 2 * winSecs;

    sendJson(res, 200, {
        ok: true,
        window_days: days,
        all_time: {
            pageviews: pvCountAll.get().n,
            unique_visitors: pvUniqAll.get().n,
            downloads: dlCountAll.get().n,
            conversations: convAll.get().n
        },
        window: {
            pageviews: pvCountSince.get(winStart).n,
            unique_visitors: pvUniqSince.get(winStart).n,
            downloads: dlCountSince.get(winStart).n,
            conversations: convSince.get(winStart).n,
            agent_turns: turnsSince.get(winStart).n,
            agent_errors: errSince.get(winStart).n
        },
        prev_window: {
            pageviews: pvCountBetween.get(prevStart, winStart).n,
            unique_visitors: pvUniqBetween.get(prevStart, winStart).n,
            downloads: dlCountBetween.get(prevStart, winStart).n
        },
        top_questions: topQStmt.all(winStart),
        geo: geoStmt.all(winStart),
        errors: errStmt.all(winStart)
    }, {});
}

// ---------- post metrics (Spec #34) ----------

function handlePostMetricsRead(req, res, cors) {
    const rows = getPostMetrics.all();
    const metrics = {};
    for (const row of rows) {
        metrics[row.post_id] = {
            reactions: row.reactions,
            comments:  row.comments,
            reposts:   row.reposts,
            fetchedAt: row.fetched_at,
        };
    }
    const payload = JSON.stringify({ ok: true, metrics });
    res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        ...cors,
    });
    res.end(payload);
}

async function handlePostMetricsWrite(req, res) {
    if (!AGENT_LOG_TOKEN) {
        return sendJson(res, 503, { ok: false, error: "Endpoint disabled" }, {});
    }
    if ((req.headers["x-internal-token"] || "") !== AGENT_LOG_TOKEN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, {});
    }
    let body;
    try { body = await readJson(req, 64 * 1024); }
    catch (_) { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }, {}); }
    const rawItems = Array.isArray(body?.items) ? body.items : null;
    if (!rawItems) {
        return sendJson(res, 400, { ok: false, error: "items must be an array" }, {});
    }
    const items = rawItems
        .filter(it => it && /^\d{10,25}$/.test(String(it.post_id || "")))
        .slice(0, 100)
        .map(it => ({
            post_id:   String(it.post_id),
            urn_type:  String(it.urn_type || "activity").slice(0, 20),
            reactions: Number.isInteger(it.reactions) && it.reactions >= 0 ? it.reactions : null,
            comments:  Number.isInteger(it.comments)  && it.comments  >= 0 ? it.comments  : null,
            reposts:   Number.isInteger(it.reposts)   && it.reposts   >= 0 ? it.reposts   : null,
        }));
    if (!items.length) {
        return sendJson(res, 200, { ok: true, written: 0 }, {});
    }
    const now = Math.floor(Date.now() / 1000);
    const insertMany = db.transaction((rows) => {
        for (const it of rows) {
            upsertPostMetric.run(it.post_id, it.urn_type, it.reactions, it.comments, it.reposts, now);
        }
    });
    try {
        insertMany(items);
        sendJson(res, 200, { ok: true, written: items.length }, {});
    } catch (err) {
        console.error("[post-metrics] write failed", err.message);
        sendJson(res, 500, { ok: false, error: "Internal" }, {});
    }
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
    if (url.pathname === "/api/resume-send-check" && req.method === "POST") {
        return handleResumeSendCheck(req, res);
    }
    if (url.pathname === "/api/resume-send-record" && req.method === "POST") {
        return handleResumeSendRecord(req, res);
    }
    if (url.pathname === "/api/ambient/interactions" && req.method === "GET") {
        return handleAmbientInteractions(req, res, url);
    }
    if (url.pathname === "/api/ambient/leads" && req.method === "GET") {
        return handleAmbientLeads(req, res);
    }
    if (url.pathname === "/api/ambient/leads/mark" && req.method === "POST") {
        return handleAmbientLeadsMark(req, res);
    }
    if (url.pathname === "/api/ambient/stats" && req.method === "GET") {
        return handleAmbientStats(req, res, url);
    }
    if (url.pathname === "/api/pageview" && req.method === "POST") {
        return handlePageview(req, res, origin, cors);
    }
    if (url.pathname === "/api/post-metrics" && req.method === "GET") {
        return handlePostMetricsRead(req, res, cors);
    }
    if (url.pathname === "/api/post-metrics" && req.method === "POST") {
        return handlePostMetricsWrite(req, res);
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
