// Cloudflare Worker — resume download gate (Google Sign-In).
// POST /api/resume-download : { credential: <Google ID token JWT> }
//   → cryptographically verify JWT via Google's JWKS (jose)
//   → dedupe per google_sub within 24h (one row per user per day)
//   → record verified identity to D1 with truncated IP
//   → respond { ok: true, url }
// GET  /api/leads : admin dump (Authorization: Bearer ADMIN_TOKEN).
// SCHEDULED : monthly retention cleanup (delete rows older than 12 months).

import * as jose from "jose";

const ALLOWED_ISS = new Set([
    "accounts.google.com",
    "https://accounts.google.com"
]);

// JWKS is fetched from Google once and cached per-isolate by jose. After the
// first verify, all subsequent verifies are local-only — no outbound network
// call per request. This is the production-grade replacement for the old
// `tokeninfo` debug endpoint.
const JWKS = jose.createRemoteJWKSet(
    new URL("https://www.googleapis.com/oauth2/v3/certs")
);

const RETENTION_SECONDS = 365 * 24 * 60 * 60;       // 12 months (resume_downloads)
const AGENT_LOG_RETENTION_SECONDS = 90 * 24 * 60 * 60; // 90 days (agent_interactions)
const DEDUPE_WINDOW_SECONDS = 24 * 60 * 60;         // 24 hours

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin") || "";
        const allowed = parseOrigins(env.ALLOWED_ORIGINS);
        const corsHeaders = buildCors(origin, allowed);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (url.pathname === "/api/resume-download" && request.method === "POST") {
            return handleDownload(request, env, origin, allowed, corsHeaders);
        }

        if (url.pathname === "/api/leads" && request.method === "GET") {
            return handleLeads(request, env, corsHeaders);
        }

        if (url.pathname === "/api/agent-log" && request.method === "POST") {
            return handleAgentLog(request, env);
        }

        if (url.pathname === "/api/agent-log" && request.method === "GET") {
            return handleAgentLogRead(request, env, corsHeaders);
        }

        return json({ ok: false, error: "Not found" }, 404, corsHeaders);
    },

    // Cron-triggered retention: deletes rows older than RETENTION_SECONDS.
    // Configured in wrangler.toml `[triggers] crons` block.
    async scheduled(event, env, ctx) {
        const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
        try {
            const { meta } = await env.DB.prepare(
                "DELETE FROM resume_downloads WHERE downloaded_at < ?"
            ).bind(cutoff).run();
            console.log(`[retention] resume: deleted ${meta?.changes ?? 0} rows older than 365d`);
        } catch (err) {
            console.error("[retention] resume cleanup failed", err);
        }

        const cutoffAgent = Math.floor(Date.now() / 1000) - AGENT_LOG_RETENTION_SECONDS;
        try {
            const { meta } = await env.DB.prepare(
                "DELETE FROM agent_interactions WHERE logged_at < ?"
            ).bind(cutoffAgent).run();
            console.log(`[retention] agent: deleted ${meta?.changes ?? 0} rows older than 90d`);
        } catch (err) {
            console.error("[retention] agent cleanup failed", err);
        }
    }
};

function parseOrigins(s) {
    return (s || "")
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);
}

function buildCors(origin, allowed) {
    const headers = {
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400"
    };
    if (origin && allowed.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
    }
    return headers;
}

function json(body, status, extra) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...(extra || {}) }
    });
}

// Truncate an IP to /24 (IPv4) or first /64 (IPv6) for GDPR data minimization.
// Keeps city-level geolocation; drops precise host identification.
function truncateIp(ip) {
    if (!ip) return "";
    if (ip.includes(":")) {
        // IPv6 — keep first 4 hextets, mask the host portion
        const hextets = ip.split(":").filter(Boolean).slice(0, 4);
        return hextets.join(":") + "::x";
    }
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
    return ""; // unrecognized format — drop entirely rather than store dirty data
}

async function verifyGoogleIdToken(credential, expectedAud) {
    if (typeof credential !== "string" || credential.length < 20 || credential.length > 4096) {
        return { ok: false, status: 400, error: "Invalid credential" };
    }
    if (!expectedAud) {
        return { ok: false, status: 503, error: "Server not configured" };
    }
    try {
        // jose validates: signature against JWKS, exp, nbf (if present),
        // iat (when ≥ 3.5.0 with maxTokenAge or default skew tolerance),
        // audience, and issuer. Throws on any failure.
        const { payload } = await jose.jwtVerify(credential, JWKS, {
            audience: expectedAud,
            issuer: Array.from(ALLOWED_ISS),
            // Reject tokens issued more than 1 hour ago (Google's default
            // ID token TTL is 1 hour; this also catches replays of expired
            // tokens before exp can save us). Allows 60s clock skew.
            maxTokenAge: "1h",
            clockTolerance: "60s"
        });
        if (payload.email_verified !== true && payload.email_verified !== "true") {
            return { ok: false, status: 401, error: "Email not verified" };
        }
        if (!payload.sub || !payload.email) {
            return { ok: false, status: 401, error: "Missing required claims" };
        }
        return { ok: true, claims: payload };
    } catch (err) {
        // jose throws specific error classes; collapse to a generic message
        // so we don't leak internal verification state to callers.
        // Logged server-side for debugging.
        console.warn("[jwt-verify] failed:", err?.code || err?.name || "unknown");
        return { ok: false, status: 401, error: "Token verification failed" };
    }
}

async function handleDownload(request, env, origin, allowed, corsHeaders) {
    if (!origin || !allowed.includes(origin)) {
        return json({ ok: false, error: "Origin not allowed" }, 403, corsHeaders);
    }
    if (!env.GOOGLE_CLIENT_ID) {
        return json({ ok: false, error: "Server not configured" }, 503, corsHeaders);
    }

    let body;
    try {
        body = await request.json();
    } catch (_) {
        return json({ ok: false, error: "Invalid JSON" }, 400, corsHeaders);
    }

    const v = await verifyGoogleIdToken(body?.credential, env.GOOGLE_CLIENT_ID);
    if (!v.ok) {
        return json({ ok: false, error: v.error }, v.status, corsHeaders);
    }
    const c = v.claims;

    // Dedupe: if this google_sub already has a row in the past 24h, return
    // success but skip the INSERT. Visitor still gets the PDF; D1 doesn't
    // collect a duplicate. Closes the JWT-replay vector and limits
    // table bloat from repeat visitors.
    const cutoff = Math.floor(Date.now() / 1000) - DEDUPE_WINDOW_SECONDS;
    try {
        const { results } = await env.DB.prepare(
            "SELECT 1 FROM resume_downloads WHERE google_sub = ? AND downloaded_at > ? LIMIT 1"
        ).bind(c.sub, cutoff).all();
        if (results && results.length > 0) {
            return json({ ok: true, url: "/assets/img/resume.pdf", deduped: true }, 200, corsHeaders);
        }
    } catch (err) {
        console.error("[dedupe] check failed", err);
        // Fall through and let the INSERT happen — better to record an
        // extra row than to fail the user's download.
    }

    const ip = truncateIp(request.headers.get("CF-Connecting-IP") || "");
    const ua = (request.headers.get("User-Agent") || "").slice(0, 500);
    const referrer = (request.headers.get("Referer") || "").slice(0, 500);
    const at = Math.floor(Date.now() / 1000);
    const name = (c.name || c.given_name || "").toString().slice(0, 200);
    const email = c.email.toString().slice(0, 200);
    const picture = (c.picture || "").toString().slice(0, 500);

    try {
        await env.DB.prepare(
            "INSERT INTO resume_downloads (google_sub, email, email_verified, name, picture, downloaded_at, ip, user_agent, referrer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(c.sub, email, 1, name, picture, at, ip, ua, referrer).run();
    } catch (err) {
        console.error("D1 insert failed", err);
        return json({ ok: false, error: "Internal" }, 500, corsHeaders);
    }

    return json({ ok: true, url: "/assets/img/resume.pdf" }, 200, corsHeaders);
}

async function handleLeads(request, env, corsHeaders) {
    const token = env.ADMIN_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Admin endpoint disabled" }, 503, corsHeaders);
    }
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${token}`) {
        return json({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
    }
    try {
        const { results } = await env.DB.prepare(
            "SELECT id, google_sub, email, email_verified, name, picture, downloaded_at, ip, user_agent, referrer FROM resume_downloads ORDER BY downloaded_at DESC LIMIT 200"
        ).all();
        return json({ ok: true, leads: results }, 200, corsHeaders);
    } catch (err) {
        console.error("D1 read failed", err);
        return json({ ok: false, error: "Internal" }, 500, corsHeaders);
    }
}

// POST /api/agent-log — internal write endpoint called by Cloud Run after each agent turn.
// Auth: X-Internal-Token header must match env.AGENT_LOG_TOKEN (no CORS — browser never calls this).
// Self-asserted identity — see Spec #23 §Trust model. Do not add JWT verification here.
async function handleAgentLog(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Agent log endpoint disabled" }, 503, {});
    }
    if (request.headers.get("X-Internal-Token") !== token) {
        return json({ ok: false, error: "Unauthorized" }, 401, {});
    }

    let body;
    try {
        body = await request.json();
    } catch (_) {
        return json({ ok: false, error: "Invalid JSON" }, 400, {});
    }

    // Validate required fields.
    const sessionId = body?.sessionId;
    const turnIndex = body?.turnIndex;
    const question  = body?.question;
    const status    = body?.status;
    const VALID_STATUSES = new Set(["ok", "error", "injection_blocked", "too_long", "rate_limited"]);

    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 64) {
        return json({ ok: false, error: "Invalid sessionId" }, 400, {});
    }
    if (typeof turnIndex !== "number" || turnIndex < 0 || !Number.isInteger(turnIndex)) {
        return json({ ok: false, error: "Invalid turnIndex" }, 400, {});
    }
    if (typeof question !== "string" || question.length < 1) {
        return json({ ok: false, error: "Invalid question" }, 400, {});
    }
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
        return json({ ok: false, error: "Invalid status" }, 400, {});
    }

    // Clamp + sanitize all string fields (same discipline as handleDownload).
    const response     = String(body?.response     ?? "").slice(0, 16000);
    const toolCallsRaw = body?.toolCalls;
    const toolCalls    = toolCallsRaw ? JSON.stringify(toolCallsRaw).slice(0, 8000) : null;
    const errorMessage = body?.errorMessage ? String(body.errorMessage).slice(0, 500) : null;
    const identity     = (body?.identity && typeof body.identity === "object") ? body.identity : {};
    const googleSub    = identity.sub  ? String(identity.sub).slice(0, 200)  : null;
    const email        = identity.email ? String(identity.email).slice(0, 200) : null;
    const ip           = truncateIp(String(body?.ip ?? ""));
    const userAgent    = String(body?.userAgent   ?? "").slice(0, 500);
    const referrer     = String(body?.referrer    ?? "").slice(0, 500);
    const agentVersion = String(body?.agentVersion ?? "").slice(0, 100);
    const tokensInput  = Number.isInteger(body?.tokensInput)  ? body.tokensInput  : null;
    const tokensOutput = Number.isInteger(body?.tokensOutput) ? body.tokensOutput : null;
    const latencyMs    = Number.isInteger(body?.latencyMs)    ? body.latencyMs    : null;
    const loggedAt     = Math.floor(Date.now() / 1000);
    // Spec #24 — meta-block extracted server-side, persisted as flat columns.
    const citationsCount   = Number.isInteger(body?.citationsCount)   ? body.citationsCount   : null;
    const suggestionsCount = Number.isInteger(body?.suggestionsCount) ? body.suggestionsCount : null;
    const cta = (body?.cta === "topmate" || body?.cta === "linkedin") ? body.cta : null;

    try {
        const { meta } = await env.DB.prepare(
            `INSERT INTO agent_interactions
               (session_id, turn_index, logged_at, question, response, tool_calls,
                tokens_input, tokens_output, latency_ms, status, error_message,
                google_sub, email, ip, user_agent, referrer, agent_version,
                citations_count, suggestions_count, cta)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            sessionId, turnIndex, loggedAt,
            question.slice(0, 4000), response, toolCalls,
            tokensInput, tokensOutput, latencyMs,
            status, errorMessage,
            googleSub, email, ip, userAgent, referrer, agentVersion,
            citationsCount, suggestionsCount, cta
        ).run();
        return json({ ok: true, id: meta?.last_row_id ?? null }, 200, {});
    } catch (err) {
        console.error("[agent-log] D1 insert failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// GET /api/agent-log — admin dump of recent agent interactions.
// Reuses ADMIN_TOKEN from spec #11 (same secret, no new credential to manage).
async function handleAgentLogRead(request, env, corsHeaders) {
    const token = env.ADMIN_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Admin endpoint disabled" }, 503, corsHeaders);
    }
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${token}`) {
        return json({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
    }
    try {
        const { results } = await env.DB.prepare(
            `SELECT id, session_id, turn_index, logged_at, question, response, tool_calls,
                    tokens_input, tokens_output, latency_ms, status, error_message,
                    google_sub, email, ip, user_agent, referrer, agent_version,
                    citations_count, suggestions_count, cta
             FROM agent_interactions ORDER BY logged_at DESC LIMIT 200`
        ).all();
        return json({ ok: true, leads: results }, 200, corsHeaders);
    } catch (err) {
        console.error("[agent-log] D1 read failed", err);
        return json({ ok: false, error: "Internal" }, 500, corsHeaders);
    }
}
