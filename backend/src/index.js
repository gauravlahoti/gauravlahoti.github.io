// Cloudflare Worker — resume-gate backend (resume-download's Google Sign-In
// flow retired 2026-06-10, see .claude/docs/backend.md; resume_downloads is
// kept read-only for its historical leads).
// GET  /api/leads : admin dump (Authorization: Bearer ADMIN_TOKEN).
// SCHEDULED : monthly retention cleanup.

const RESUME_SEND_WINDOW_SECONDS = 24 * 60 * 60;    // per-recipient rate-limit window
const RETENTION_REDACT_SECONDS = 30 * 24 * 60 * 60;  // agent_interactions text -> NULL; resume_sends/note_sends delete
const RETENTION_PAGEVIEWS_SECONDS = 180 * 24 * 60 * 60; // page_views raw row delete (rolled up first)
const RETENTION_LONG_SECONDS = 365 * 24 * 60 * 60;   // agent_interactions row delete; send_failures delete

// Blended per-1M-token pricing for daily_stats.cost_usd, mirroring the
// constants ambient_send.py already uses for the live digest (which prices
// gemini-2.5-flash). Atlas cascades through several models on 429/503, so a
// day's tokens can span more than one real rate — this rollup is a labelled
// approximation for historical trend purposes once the source rows redact,
// not an exact reconciliation. The live digest prices recent turns by their
// actual agent_interactions.model column instead.
const BLENDED_PRICE_IN_PER_1M = 0.15;
const BLENDED_PRICE_OUT_PER_1M = 0.60;
const SEND_AGGREGATE_WINDOW_SECONDS = 60 * 60;      // global cap window (resume_sends / note_sends)
const SEND_AGGREGATE_LIMIT = 20;                    // max sends per table per window, across all recipients

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin") || "";
        const allowed = parseOrigins(env.ALLOWED_ORIGINS);
        const corsHeaders = buildCors(origin, allowed);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
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

        if (url.pathname === "/api/resume-send-check" && request.method === "POST") {
            return handleResumeSendCheck(request, env);
        }

        if (url.pathname === "/api/resume-send-record" && request.method === "POST") {
            return handleResumeSendRecord(request, env);
        }

        if (url.pathname === "/api/note-send-check" && request.method === "POST") {
            return handleNoteSendCheck(request, env);
        }

        if (url.pathname === "/api/note-send-record" && request.method === "POST") {
            return handleNoteSendRecord(request, env);
        }

        if (url.pathname === "/api/send-fail" && request.method === "POST") {
            return handleSendFail(request, env);
        }

        if (url.pathname === "/api/gcp-cost" && request.method === "GET") {
            return handleGcpCost(request, env, corsHeaders);
        }

        if (url.pathname === "/api/gcp-cost-send" && request.method === "POST") {
            return handleGcpCostSend(request, env, corsHeaders);
        }

        if (url.pathname === "/api/agent-stats" && request.method === "GET") {
            return handleAgentStats(request, env, corsHeaders);
        }

        if (url.pathname === "/api/agent-geo-stats" && request.method === "GET") {
            return handleAgentGeoStats(request, env, corsHeaders);
        }

        if (url.pathname === "/api/ambient/interactions" && request.method === "GET") {
            return handleAmbientInteractions(request, env);
        }

        if (url.pathname === "/api/ambient/stats" && request.method === "GET") {
            return handleAmbientStats(request, env);
        }

        if (url.pathname === "/api/pageview" && request.method === "POST") {
            return handlePageview(request, env, origin, allowed, corsHeaders);
        }

        if (url.pathname === "/api/post-metrics" && request.method === "GET") {
            return handlePostMetricsRead(request, env, corsHeaders);
        }

        if (url.pathname === "/api/post-metrics" && request.method === "POST") {
            return handlePostMetricsWrite(request, env);
        }

        return json({ ok: false, error: "Not found" }, 404, corsHeaders);
    },

    // Cron-triggered scheduled handler. One cron:
    //   "0 2 1 * *" — monthly retention cleanup (1st of month, 02:00 UTC)
    // (The ambient agent now runs on Cloud Run, triggered by a Claude scheduler
    //  via POST /api/ambient/run — see portfolio-agent. This Worker only serves
    //  the thin D1 read/mark endpoints it calls.)
    async scheduled(event, env, ctx) {
        // Monthly retention cleanup ("0 2 1 * *"). Roll up FIRST: every table
        // below is either deleted or redacted after this point, and the
        // rollup is what keeps "all-time" counters (the public agent-stats
        // badge, the digest's all-time figures) correct once source rows are
        // gone. Getting this order backwards was the original bug — the old
        // cron deleted straight from agent_interactions/page_views with no
        // rollup at all, so those "all-time" numbers were silently just
        // "however far back the last purge reached." It regressed once
        // (spec 54: daily_stats itself went missing for months, the rollup
        // failed silently, and every delete below still ran), so the
        // destructive phase is now conditional on the rollup actually
        // succeeding rather than merely being attempted.
        const rolledUp = await rollupDailyStats(env);
        if (!rolledUp) {
            console.error(
                "[retention] rollup did not fully succeed this run — skipping " +
                "redact/delete to avoid purging days daily_stats has not captured. " +
                "Will retry in full next run; nothing here is time-critical."
            );
            return;
        }

        // resume_downloads: deliberately EXEMPT. Its write path (the Google
        // Sign-In gate) was retired 2026-06-10 — see .claude/docs/backend.md.
        // It's now a finite historical dataset, not one that needs ongoing
        // purging. Do not add a DELETE for this table without re-checking
        // whether the gate is still dead.

        const now = Math.floor(Date.now() / 1000);
        const redactCutoff = now - RETENTION_REDACT_SECONDS;      // 30d
        const pageviewsCutoff = now - RETENTION_PAGEVIEWS_SECONDS; // 180d
        const longCutoff = now - RETENTION_LONG_SECONDS;          // 365d

        // agent_interactions: redact free text at 30d (visitors type PII into
        // a chat box), keep the row + every metric column (tokens, status,
        // model, latency) until 365d. The IS NOT NULL guard keeps re-runs
        // from reporting every already-redacted row as "changed" again.
        try {
            const { meta } = await env.DB.prepare(
                "UPDATE agent_interactions SET question = NULL, response = NULL WHERE logged_at < ? AND question IS NOT NULL"
            ).bind(redactCutoff).run();
            console.log(`[retention] agent_interactions: redacted text on ${meta?.changes ?? 0} rows older than 30d`);
        } catch (err) {
            console.error("[retention] agent_interactions redact failed", err);
        }
        try {
            const { meta } = await env.DB.prepare(
                "DELETE FROM agent_interactions WHERE logged_at < ?"
            ).bind(longCutoff).run();
            console.log(`[retention] agent_interactions: deleted ${meta?.changes ?? 0} rows older than 365d`);
        } catch (err) {
            console.error("[retention] agent_interactions delete failed", err);
        }

        // resume_sends / note_sends: pure rate-limit ledgers whose windows
        // are 24h/1h — 90d of retention was 89 days of dead weight. 30d now.
        try {
            const { meta } = await env.DB.prepare(
                "DELETE FROM resume_sends WHERE sent_at < ?"
            ).bind(redactCutoff).run();
            console.log(`[retention] resume_sends: deleted ${meta?.changes ?? 0} rows older than 30d`);
        } catch (err) {
            console.error("[retention] resume_sends cleanup failed", err);
        }
        try {
            const { meta } = await env.DB.prepare(
                "DELETE FROM note_sends WHERE sent_at < ?"
            ).bind(redactCutoff).run();
            console.log(`[retention] note_sends: deleted ${meta?.changes ?? 0} rows older than 30d`);
        } catch (err) {
            console.error("[retention] note_sends cleanup failed", err);
        }

        // send_failures: never had a retention rule before this — an
        // omission from when the table was added. Low volume (~6/mo), high
        // diagnostic value, so 365d.
        try {
            const { meta } = await env.DB.prepare(
                "DELETE FROM send_failures WHERE failed_at < ?"
            ).bind(longCutoff).run();
            console.log(`[retention] send_failures: deleted ${meta?.changes ?? 0} rows older than 365d`);
        } catch (err) {
            console.error("[retention] send_failures cleanup failed", err);
        }

        // page_views: raw rows only needed for recent path/geo detail once
        // rolled up above, so the window tightens from 365d to 180d.
        try {
            const { meta } = await env.DB.prepare(
                "DELETE FROM page_views WHERE viewed_at < ?"
            ).bind(pageviewsCutoff).run();
            console.log(`[retention] page_views: deleted ${meta?.changes ?? 0} rows older than 180d`);
        } catch (err) {
            console.error("[retention] page_views cleanup failed", err);
        }
    }
};

// Roll up every UTC day (strictly before today, so an in-progress day is
// never partially rolled up) that has source data and no daily_stats row
// yet. Idempotent — a day already in daily_stats is never touched again, so
// running this cron early, late, or twice in the same month is harmless.
// Returns whether it is safe to run the destructive phase that follows.
// `false` means at least one day's source rows are not yet reflected in
// daily_stats — in that case the caller must skip deletion for this run
// rather than purge data no rollup will ever cover again. See spec 54: this
// table was missing entirely for months, the candidate-day query silently
// failed, and the deletes below ran anyway.
async function rollupDailyStats(env) {
    let days;
    try {
        const { results } = await env.DB.prepare(
            `SELECT day FROM (
               SELECT DISTINCT date(viewed_at, 'unixepoch') AS day FROM page_views
               UNION
               SELECT DISTINCT date(logged_at, 'unixepoch') AS day FROM agent_interactions
               UNION
               SELECT DISTINCT date(failed_at, 'unixepoch') AS day FROM send_failures
             )
             WHERE day < date('now') AND day NOT IN (SELECT day FROM daily_stats)
             ORDER BY day`
        ).all();
        days = results || [];
    } catch (err) {
        console.error("[retention] daily_stats candidate-day query failed", err);
        return false;
    }
    let ok = 0;
    for (const { day } of days) {
        try {
            await rollupOneDay(env, day);
            ok++;
        } catch (err) {
            console.error(`[retention] daily_stats rollup failed for ${day}`, err);
        }
    }
    if (days.length) {
        console.log(`[retention] daily_stats: rolled up ${ok}/${days.length} day(s)`);
    }
    return ok === days.length;
}

async function rollupOneDay(env, day) {
    const { results } = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM page_views WHERE date(viewed_at,'unixepoch') = ?1) AS pageviews,
           (SELECT COUNT(DISTINCT visitor_hash) FROM page_views WHERE date(viewed_at,'unixepoch') = ?1) AS unique_visitors,
           (SELECT COUNT(*) FROM resume_downloads WHERE date(downloaded_at,'unixepoch') = ?1) AS downloads,
           (SELECT COUNT(DISTINCT session_id) FROM agent_interactions WHERE date(logged_at,'unixepoch') = ?1) AS conversations,
           (SELECT COUNT(*) FROM agent_interactions WHERE date(logged_at,'unixepoch') = ?1) AS turns,
           (SELECT COALESCE(SUM(tokens_input),0) FROM agent_interactions WHERE date(logged_at,'unixepoch') = ?1) AS tokens_in,
           (SELECT COALESCE(SUM(tokens_output),0) FROM agent_interactions WHERE date(logged_at,'unixepoch') = ?1) AS tokens_out,
           (SELECT COUNT(*) FROM agent_interactions WHERE date(logged_at,'unixepoch') = ?1 AND status != 'ok') AS errors,
           (SELECT COUNT(*) FROM send_failures WHERE date(failed_at,'unixepoch') = ?1) AS send_failures,
           (SELECT COUNT(DISTINCT session_id) FROM page_views
              WHERE date(viewed_at,'unixepoch') = ?1 AND session_id IS NOT NULL) AS pageview_sessions,
           (SELECT COUNT(DISTINCT pv.session_id) FROM page_views pv
              WHERE date(pv.viewed_at,'unixepoch') = ?1 AND pv.session_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM agent_interactions ai
                  WHERE ai.session_id = pv.session_id AND date(ai.logged_at,'unixepoch') = ?1
                )) AS pageview_sessions_chatted,
           (SELECT latency_ms FROM agent_interactions
              WHERE date(logged_at,'unixepoch') = ?1 AND latency_ms IS NOT NULL
              ORDER BY latency_ms LIMIT 1 OFFSET (
                SELECT MAX((COUNT(*) - 1) / 2, 0) FROM agent_interactions
                WHERE date(logged_at,'unixepoch') = ?1 AND latency_ms IS NOT NULL
              )) AS latency_p50_ms,
           (SELECT latency_ms FROM agent_interactions
              WHERE date(logged_at,'unixepoch') = ?1 AND latency_ms IS NOT NULL
              ORDER BY latency_ms LIMIT 1 OFFSET (
                SELECT MAX(CAST((COUNT(*) - 1) * 0.95 AS INTEGER), 0) FROM agent_interactions
                WHERE date(logged_at,'unixepoch') = ?1 AND latency_ms IS NOT NULL
              )) AS latency_p95_ms`
    ).bind(day).all();
    const r = (results && results[0]) || {};
    const costUsd =
        ((r.tokens_in || 0) * BLENDED_PRICE_IN_PER_1M + (r.tokens_out || 0) * BLENDED_PRICE_OUT_PER_1M) / 1_000_000;

    await env.DB.prepare(
        `INSERT OR IGNORE INTO daily_stats
           (day, pageviews, unique_visitors, downloads, conversations, turns,
            tokens_in, tokens_out, cost_usd, errors, send_failures,
            pageview_sessions, pageview_sessions_chatted,
            latency_p50_ms, latency_p95_ms, rolled_up_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        day, r.pageviews || 0, r.unique_visitors || 0, r.downloads || 0,
        r.conversations || 0, r.turns || 0, r.tokens_in || 0, r.tokens_out || 0,
        costUsd, r.errors || 0, r.send_failures || 0,
        r.pageview_sessions || 0, r.pageview_sessions_chatted || 0,
        r.latency_p50_ms ?? null, r.latency_p95_ms ?? null,
        Math.floor(Date.now() / 1000)
    ).run();
}

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

// SHA-256 → hex. Used to derive a daily-rotating visitor hash from
// ip + ua + UTC date so unique-visitor counts work without cookies and the
// raw IP is never stored (same privacy posture as resume_sends).
async function sha256hex(input) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
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

    // Clamp + sanitize all string fields before they touch D1.
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
    // Geo fields resolved on Cloud Run from the untruncated client IP.
    const geoStr = (v) => {
        if (typeof v !== "string") return null;
        const s = v.slice(0, 64).trim();
        return s.length ? s : null;
    };
    const country = geoStr(body?.country);
    const region  = geoStr(body?.region);
    const city    = geoStr(body?.city);
    // Which model actually answered — Atlas cascades gemini-3.7-flash ->
    // 3.6-flash on 429/503, so this is not always the primary model.
    // 0 = primary, higher = further down the chain.
    const model = body?.model ? String(body.model).slice(0, 64) : null;
    const modelFallbackDepth =
        Number.isInteger(body?.modelFallbackDepth) && body.modelFallbackDepth >= 0
            ? body.modelFallbackDepth
            : null;
    // Gemini thought-summary aggregate — raw thought text is never sent here,
    // only the token count and whether the turn produced any.
    const thinkingTokens = Number.isInteger(body?.thinkingTokens) ? body.thinkingTokens : null;
    const hadThinking = body?.hadThinking === true ? 1 : 0;

    try {
        const { meta } = await env.DB.prepare(
            `INSERT INTO agent_interactions
               (session_id, turn_index, logged_at, question, response, tool_calls,
                tokens_input, tokens_output, latency_ms, status, error_message,
                google_sub, email, ip, user_agent, referrer, agent_version,
                citations_count, suggestions_count, cta,
                country, region, city, model, model_fallback_depth,
                thinking_tokens, had_thinking)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            sessionId, turnIndex, loggedAt,
            question.slice(0, 4000), response, toolCalls,
            tokensInput, tokensOutput, latencyMs,
            status, errorMessage,
            googleSub, email, ip, userAgent, referrer, agentVersion,
            citationsCount, suggestionsCount, cta,
            country, region, city, model, modelFallbackDepth,
            thinkingTokens, hadThinking
        ).run();
        return json({ ok: true, id: meta?.last_row_id ?? null }, 200, {});
    } catch (err) {
        console.error("[agent-log] D1 insert failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// Shared global circuit-breaker: reject once a table has taken more than
// `limit` sends in the trailing `windowSeconds`, regardless of per-recipient
// dedupe. Bounds a distributed caller spreading requests across many IPs/
// recipients (each individually within its own per-recipient allowance) from
// still driving unbounded aggregate email volume/cost.
async function checkGlobalSendCap(env, table, windowSeconds, limit) {
    const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
    const { results } = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE sent_at > ?`
    ).bind(cutoff).all();
    const count = results?.[0]?.n ?? 0;
    return count < limit;
}

// POST /api/resume-send-check — pre-send rate-limit gate for the agent's send_resume tool.
// Returns { allowed: boolean, reason?: string } based on whether the same
// email_hash has been recorded in the last RESUME_SEND_WINDOW_SECONDS, and
// whether the table as a whole is under the global aggregate cap. No row is
// written here. `reason` distinguishes the two denial causes ("global_cap" vs
// "recipient_recent") so the agent can tell the visitor something true — a
// bare allowed:false made it report a global throttle as "already sent to you".
async function handleResumeSendCheck(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Endpoint disabled" }, 503, {});
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
    const emailHash = body?.emailHash;
    if (typeof emailHash !== "string" || emailHash.length < 8 || emailHash.length > 64) {
        return json({ ok: false, error: "Invalid emailHash" }, 400, {});
    }
    const cutoff = Math.floor(Date.now() / 1000) - RESUME_SEND_WINDOW_SECONDS;
    try {
        const underGlobalCap = await checkGlobalSendCap(
            env, "resume_sends", SEND_AGGREGATE_WINDOW_SECONDS, SEND_AGGREGATE_LIMIT
        );
        if (!underGlobalCap) {
            console.warn("[resume-send-check] global cap reached", SEND_AGGREGATE_LIMIT);
            return json({ ok: true, allowed: false, reason: "global_cap" }, 200, {});
        }
        const { results } = await env.DB.prepare(
            "SELECT 1 FROM resume_sends WHERE email_hash = ? AND sent_at > ? LIMIT 1"
        ).bind(emailHash, cutoff).all();
        const recentlySent = !!(results && results.length > 0);
        return json(
            recentlySent
                ? { ok: true, allowed: false, reason: "recipient_recent" }
                : { ok: true, allowed: true },
            200, {}
        );
    } catch (err) {
        console.error("[resume-send-check] D1 read failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// POST /api/resume-send-record — records a successful send. Only called by
// the agent after the MCP/Resend send returned ok. Two endpoints (check vs
// record) so a denied check never accidentally writes a row.
async function handleResumeSendRecord(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Endpoint disabled" }, 503, {});
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
    const emailHash = body?.emailHash;
    if (typeof emailHash !== "string" || emailHash.length < 8 || emailHash.length > 64) {
        return json({ ok: false, error: "Invalid emailHash" }, 400, {});
    }
    const sentAt = Math.floor(Date.now() / 1000);
    try {
        const { meta } = await env.DB.prepare(
            "INSERT INTO resume_sends (email_hash, sent_at) VALUES (?, ?)"
        ).bind(emailHash, sentAt).run();
        return json({ ok: true, id: meta?.last_row_id ?? null }, 200, {});
    } catch (err) {
        console.error("[resume-send-record] D1 insert failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// POST /api/send-fail — records an outbound email that FAILED to send, so
// failures are countable rather than inferred from a missing resume_sends row.
// Deliberately separate from the agent_interactions audit log, which is written
// fire-and-forget only after a chat turn finishes streaming: a turn that dies
// mid-stream leaves no audit row, but the failure still happened.
// Body: { kind: "resume"|"note", code: "<short-code>", emailHash?: "<hash>" }
async function handleSendFail(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Endpoint disabled" }, 503, {});
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
    const kind = body?.kind;
    if (kind !== "resume" && kind !== "note") {
        return json({ ok: false, error: "Invalid kind" }, 400, {});
    }
    const code = body?.code;
    if (typeof code !== "string" || code.length < 2 || code.length > 64) {
        return json({ ok: false, error: "Invalid code" }, 400, {});
    }
    // Optional: a failure can predate having a usable hash.
    const rawHash = body?.emailHash;
    const emailHash =
        typeof rawHash === "string" && rawHash.length >= 8 && rawHash.length <= 64
            ? rawHash
            : null;
    // sessionId links a failure back to the conversation the visitor was in.
    // attempts tells you whether the retry logic rescued the send or just
    // delayed the failure.
    const sessionId = body?.sessionId ? String(body.sessionId).slice(0, 128) : null;
    const attempts =
        Number.isInteger(body?.attempts) && body.attempts >= 0 && body.attempts <= 100
            ? body.attempts
            : null;
    const latencyMs =
        Number.isFinite(body?.latencyMs) && body.latencyMs >= 0
            ? Math.round(body.latencyMs)
            : null;
    const failedAt = Math.floor(Date.now() / 1000);
    try {
        const { meta } = await env.DB.prepare(
            `INSERT INTO send_failures (kind, code, email_hash, failed_at, session_id, attempts, latency_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(kind, code, emailHash, failedAt, sessionId, attempts, latencyMs).run();
        return json({ ok: true, id: meta?.last_row_id ?? null }, 200, {});
    } catch (err) {
        console.error("[send-fail] D1 insert failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// POST /api/note-send-check — pre-send rate-limit gate for the agent's
// send_note_to_gaurav tool. Mirrors handleResumeSendCheck but against the
// note_sends table, keyed on the visitor's email (used as CC + Reply-To).
async function handleNoteSendCheck(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Endpoint disabled" }, 503, {});
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
    const emailHash = body?.emailHash;
    if (typeof emailHash !== "string" || emailHash.length < 8 || emailHash.length > 64) {
        return json({ ok: false, error: "Invalid emailHash" }, 400, {});
    }
    const cutoff = Math.floor(Date.now() / 1000) - RESUME_SEND_WINDOW_SECONDS;
    try {
        const underGlobalCap = await checkGlobalSendCap(
            env, "note_sends", SEND_AGGREGATE_WINDOW_SECONDS, SEND_AGGREGATE_LIMIT
        );
        if (!underGlobalCap) {
            console.warn("[note-send-check] global cap reached", SEND_AGGREGATE_LIMIT);
            return json({ ok: true, allowed: false, reason: "global_cap" }, 200, {});
        }
        const { results } = await env.DB.prepare(
            "SELECT 1 FROM note_sends WHERE email_hash = ? AND sent_at > ? LIMIT 1"
        ).bind(emailHash, cutoff).all();
        const recentlySent = !!(results && results.length > 0);
        return json(
            recentlySent
                ? { ok: true, allowed: false, reason: "recipient_recent" }
                : { ok: true, allowed: true },
            200, {}
        );
    } catch (err) {
        console.error("[note-send-check] D1 read failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// POST /api/note-send-record — records a successful send. Only called by the
// agent after the MCP/Resend send returned ok.
async function handleNoteSendRecord(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Endpoint disabled" }, 503, {});
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
    const emailHash = body?.emailHash;
    if (typeof emailHash !== "string" || emailHash.length < 8 || emailHash.length > 64) {
        return json({ ok: false, error: "Invalid emailHash" }, 400, {});
    }
    const sentAt = Math.floor(Date.now() / 1000);
    try {
        const { meta } = await env.DB.prepare(
            "INSERT INTO note_sends (email_hash, sent_at) VALUES (?, ?)"
        ).bind(emailHash, sentAt).run();
        return json({ ok: true, id: meta?.last_row_id ?? null }, 200, {});
    } catch (err) {
        console.error("[note-send-record] D1 insert failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// ─── GCP Cost Raw Data ────────────────────────────────────────────────────────
//
// GET /api/gcp-cost — returns raw BQ billing rows for the last 14 days.
// Analysis, anomaly detection, and email are handled by the Claude routine.
// Auth: Authorization: Bearer COST_MONITOR_TOKEN
//
// Required secrets: COST_MONITOR_TOKEN, GCP_SA_KEY_JSON
// Required vars:    GCP_BQ_TABLE, GCP_BQ_PROJECT, GCP_PROJECTS_FILTER (optional)

async function handleGcpCost(request, env, corsHeaders) {
    const token = env.COST_MONITOR_TOKEN;
    if (!token) return json({ ok: false, error: "Cost monitor disabled (set COST_MONITOR_TOKEN)" }, 503, corsHeaders);
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${token}`) return json({ ok: false, error: "Unauthorized" }, 401, corsHeaders);

    const missing = ["GCP_SA_KEY_JSON", "GCP_BQ_TABLE", "GCP_BQ_PROJECT"].filter(k => !env[k]);
    if (missing.length) return json({ ok: false, error: `Missing config: ${missing.join(", ")}` }, 503, corsHeaders);

    let accessToken;
    try {
        accessToken = await gcpAccessToken(env.GCP_SA_KEY_JSON);
    } catch (err) {
        console.error("[gcp-cost] SA auth failed", err.message);
        return json({ ok: false, error: "GCP auth failed: " + err.message }, 500, corsHeaders);
    }

    const projectFilter = (env.GCP_PROJECTS_FILTER || "").split(",").map(s => s.trim()).filter(Boolean);
    const projectClause = projectFilter.length
        ? `AND project.id IN (${projectFilter.map(p => `'${p.replace(/'/g, "")}'`).join(",")})`
        : "";
    const table = (env.GCP_BQ_TABLE || "").replace(/`/g, "");
    const sql = `
        SELECT
          project.id AS project_id,
          service.description AS service,
          ROUND(SUM(CASE WHEN DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
                         THEN cost ELSE 0 END), 4) AS this_week,
          ROUND(SUM(CASE WHEN DATE(usage_start_time) < DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
                         THEN cost ELSE 0 END), 4) AS last_week
        FROM \`${table}\`
        WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
          AND cost != 0
          ${projectClause}
        GROUP BY 1, 2
        HAVING this_week > 0.01 OR last_week > 0.01
        ORDER BY this_week DESC
        LIMIT 100`;

    let rows;
    try {
        rows = await bqQuery(accessToken, env.GCP_BQ_PROJECT, sql);
    } catch (err) {
        console.error("[gcp-cost] BQ query failed", err.message);
        return json({ ok: false, error: "BQ query failed: " + err.message }, 500, corsHeaders);
    }

    return json({ ok: true, generated_at: new Date().toISOString(), rows }, 200, corsHeaders);
}

// base64url-encode a string or ArrayBuffer
function b64url(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Exchange a GCP service account JSON for a short-lived access token.
async function gcpAccessToken(saKeyJson) {
    const sa = JSON.parse(saKeyJson);
    const pem = sa.private_key
        .replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "")
        .replace(/[\r\n\s]/g, "");
    const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        "pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
    );
    const now = Math.floor(Date.now() / 1000);
    const hdr = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const pay = b64url(JSON.stringify({
        iss: sa.client_email, scope: "https://www.googleapis.com/auth/bigquery.readonly",
        aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
    }));
    const sig = b64url(await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${hdr}.${pay}`)
    ));
    const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${hdr}.${pay}.${sig}`
    });
    if (!resp.ok) throw new Error(`token exchange HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const { access_token } = await resp.json();
    return access_token;
}

// Run a synchronous BigQuery query and return rows as plain objects.
async function bqQuery(accessToken, projectId, sql) {
    const resp = await fetch(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`,
        {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 25000, maxResults: 100 })
        }
    );
    if (!resp.ok) throw new Error(`BQ HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    if (!data.jobComplete) throw new Error("BQ did not complete in 25s");
    if (data.errors?.length) throw new Error(JSON.stringify(data.errors[0]).slice(0, 200));
    if (!data.rows) return [];
    const fields = data.schema.fields.map(f => f.name);
    const nums = new Set(data.schema.fields
        .filter(f => ["FLOAT","NUMERIC","INTEGER","INT64","FLOAT64"].includes(f.type))
        .map(f => f.name));
    return data.rows.map(row =>
        Object.fromEntries(row.f.map((cell, i) =>
            [fields[i], nums.has(fields[i]) ? parseFloat(cell.v ?? 0) : (cell.v ?? "")]
        ))
    );
}

// POST /api/gcp-cost-send — Claude posts composed subject+html here; Worker sends
// via Resend. Keeps the Resend API key out of the routine prompt entirely.
// Auth: Authorization: Bearer COST_MONITOR_TOKEN
async function handleGcpCostSend(request, env, corsHeaders) {
    const token = env.COST_MONITOR_TOKEN;
    if (!token) return json({ ok: false, error: "Cost monitor disabled" }, 503, corsHeaders);
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${token}`) return json({ ok: false, error: "Unauthorized" }, 401, corsHeaders);

    const missing = ["RESEND_API_KEY", "RESEND_FROM", "RESEND_TO"].filter(k => !env[k]);
    if (missing.length) return json({ ok: false, error: `Missing config: ${missing.join(", ")}` }, 503, corsHeaders);

    let body;
    try { body = await request.json(); } catch (_) {
        return json({ ok: false, error: "Invalid JSON" }, 400, corsHeaders);
    }
    const subject = typeof body?.subject === "string" ? body.subject.slice(0, 300) : "";
    const html    = typeof body?.html    === "string" ? body.html.slice(0, 500000) : "";
    if (!subject || !html) return json({ ok: false, error: "subject and html required" }, 400, corsHeaders);

    const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.RESEND_FROM, to: [env.RESEND_TO], subject, html })
    });
    if (!resp.ok) {
        const err = await resp.text();
        console.error("[gcp-cost-send] Resend failed", resp.status, err.slice(0, 200));
        return json({ ok: false, error: `Resend ${resp.status}` }, 500, corsHeaders);
    }
    const { id } = await resp.json();
    return json({ ok: true, resend_id: id, sent_to: env.RESEND_TO }, 200, corsHeaders);
}

// ─── GET /api/agent-stats ────────────────────────────────────────────────────
// Public endpoint — returns cumulative conversation count for the ambient
// presence widget. No auth required; 1h CDN cache keeps it cheap.

async function handleAgentStats(request, env, corsHeaders) {
    try {
        // Rolled-up days + a live tail of whatever hasn't been rolled up yet
        // (normally just today; more if the monthly cron missed a run) —
        // an unwindowed COUNT(*) here used to silently shrink every time the
        // retention cron deleted old rows, so this "total" was never
        // actually a lifetime figure. See daily_stats in .claude/docs/backend.md.
        const { results } = await env.DB.prepare(
            `SELECT
               (SELECT COALESCE(SUM(turns),0) FROM daily_stats) +
               (SELECT COUNT(*) FROM agent_interactions
                WHERE date(logged_at,'unixepoch') NOT IN (SELECT day FROM daily_stats)) AS total`
        ).all();
        const total = results?.[0]?.total ?? 0;
        return new Response(JSON.stringify({ ok: true, total_conversations: total }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=3600",
                ...corsHeaders
            }
        });
    } catch (err) {
        console.error("[agent-stats] D1 query failed", err);
        return json({ ok: false, error: "Internal" }, 500, corsHeaders);
    }
}

// ─── GET /api/agent-geo-stats ────────────────────────────────────────────────
// Public endpoint — all-time count of distinct countries/cities that have
// chatted with Atlas, plus a top-N breakdown. Aggregate-only: country and
// city, never a per-row question/response/ip/email, so this is safe to
// expose with no token (same posture as /api/agent-stats). 1h CDN cache.
//
// Unlike /api/agent-stats, this is a direct unwindowed query over
// agent_interactions rather than daily_stats + live tail — country/city
// have no rollup column yet (Tier 2, deferred; see .claude/docs/backend.md's
// note on page_views.unique_locations, same situation here), so this figure
// will start shrinking once individual rows cross the 365-day full delete.
// It is accurate today; it is not retention-proof the way total_conversations
// is. Revisit if that matters before this endpoint is a year old.

async function handleAgentGeoStats(request, env, corsHeaders) {
    try {
        const totals = await env.DB.prepare(
            `SELECT COUNT(DISTINCT country) AS countries,
                    COUNT(DISTINCT COALESCE(country,'') || '|' || COALESCE(city,'')) AS cities
             FROM agent_interactions
             WHERE country IS NOT NULL AND country != ''`
        ).all();
        const top = await env.DB.prepare(
            `SELECT country, city, COUNT(*) AS count
             FROM agent_interactions
             WHERE country IS NOT NULL AND country != ''
             GROUP BY country, city
             ORDER BY count DESC
             LIMIT 10`
        ).all();
        return new Response(JSON.stringify({
            ok: true,
            countries: totals.results?.[0]?.countries ?? 0,
            cities: totals.results?.[0]?.cities ?? 0,
            top: top.results || []
        }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=3600",
                ...corsHeaders
            }
        });
    } catch (err) {
        console.error("[agent-geo-stats] D1 query failed", err);
        return json({ ok: false, error: "Internal" }, 500, corsHeaders);
    }
}

// ─── LinkedIn post metrics (Spec #34) ───────────────────────────────────────

// GET /api/post-metrics — public, CORS-gated, 1h CDN cache.
// Returns { ok, metrics: { "<post_id>": { reactions, comments, reposts, fetchedAt } } }
// keyed by the numeric activity id for O(1) frontend merge.
async function handlePostMetricsRead(request, env, corsHeaders) {
    try {
        const { results } = await env.DB.prepare(
            "SELECT post_id, reactions, comments, reposts, fetched_at FROM post_metrics"
        ).all();
        const metrics = {};
        for (const row of (results || [])) {
            metrics[row.post_id] = {
                reactions: row.reactions,
                comments:  row.comments,
                reposts:   row.reposts,
                fetchedAt: row.fetched_at,
            };
        }
        return new Response(JSON.stringify({ ok: true, metrics }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=3600",
                ...corsHeaders,
            },
        });
    } catch (err) {
        console.error("[post-metrics] read failed", err);
        return json({ ok: false, error: "Internal" }, 500, corsHeaders);
    }
}

// POST /api/post-metrics — internal (Cloud Run → Worker). No CORS.
// Body: { items: [{post_id, urn_type, reactions, comments, reposts}, ...] }
// Upserts with COALESCE so a null (unparsed) field never wipes a prior good value.
async function handlePostMetricsWrite(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Endpoint disabled" }, 503, {});
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
    const rawItems = Array.isArray(body?.items) ? body.items : null;
    if (!rawItems) {
        return json({ ok: false, error: "items must be an array" }, 400, {});
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
        return json({ ok: true, written: 0 }, 200, {});
    }
    const now = Math.floor(Date.now() / 1000);
    const stmt = env.DB.prepare(
        `INSERT INTO post_metrics (post_id, urn_type, reactions, comments, reposts, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id) DO UPDATE SET
           urn_type   = excluded.urn_type,
           reactions  = COALESCE(excluded.reactions, post_metrics.reactions),
           comments   = COALESCE(excluded.comments,  post_metrics.comments),
           reposts    = COALESCE(excluded.reposts,   post_metrics.reposts),
           fetched_at = excluded.fetched_at`
    );
    try {
        await env.DB.batch(items.map(it =>
            stmt.bind(it.post_id, it.urn_type, it.reactions, it.comments, it.reposts, now)
        ));
        return json({ ok: true, written: items.length }, 200, {});
    } catch (err) {
        console.error("[post-metrics] write failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// ─── Ambient agent — D1 data endpoints ──────────────────────────────────────
// The ambient agent itself now runs on Cloud Run (ADK), triggered twice weekly
// by a Claude scheduler. Reasoning and email live there. This Worker only
// exposes the D1 reads/writes the agent needs — it is the only thing that can
// reach D1. All three are gated by X-Internal-Token === env.AGENT_LOG_TOKEN
// (the same shared secret used for /api/agent-log; server-to-server only,
// never sent from a browser, so no CORS headers).

// GET /api/ambient/interactions?days=3 — recent agent turns for the digest.
async function handleAmbientInteractions(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Endpoint disabled" }, 503, {});
    }
    if (request.headers.get("X-Internal-Token") !== token) {
        return json({ ok: false, error: "Unauthorized" }, 401, {});
    }
    const url = new URL(request.url);
    let days = parseInt(url.searchParams.get("days") || "3", 10);
    if (!Number.isFinite(days)) days = 3;
    days = Math.max(1, Math.min(30, days));
    const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    try {
        const { results } = await env.DB.prepare(
            `SELECT question, response, status, country, city, logged_at
             FROM agent_interactions WHERE logged_at > ?
             ORDER BY logged_at DESC LIMIT 100`
        ).bind(cutoff).all();
        return json({ ok: true, interactions: results || [] }, 200, {});
    } catch (err) {
        console.error("[ambient] interactions query failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// GET /api/ambient/stats?days=4 — pre-aggregated metrics for the weekly digest.
// Combines page_views (real site traffic), agent_interactions (questions/errors),
// and resume_downloads (downloads). Gated by X-Internal-Token like the other
// /api/ambient reads. All counts are computed in SQL; no PII leaves D1.
async function handleAmbientStats(request, env) {
    const token = env.AGENT_LOG_TOKEN;
    if (!token) {
        return json({ ok: false, error: "Endpoint disabled" }, 503, {});
    }
    if (request.headers.get("X-Internal-Token") !== token) {
        return json({ ok: false, error: "Unauthorized" }, 401, {});
    }
    const url = new URL(request.url);
    let days = parseInt(url.searchParams.get("days") || "4", 10);
    if (!Number.isFinite(days)) days = 4;
    days = Math.max(1, Math.min(30, days));
    const now = Math.floor(Date.now() / 1000);
    const winSecs = days * 24 * 60 * 60;
    const winStart = now - winSecs;          // window: [winStart, now]
    const prevStart = now - 2 * winSecs;     // prev window: [prevStart, winStart]

    // Helper: run a query, return the first row (or {}).
    const one = async (sql, ...binds) => {
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        return (results && results[0]) || {};
    };

    try {
        // Rolled-up days (daily_stats) + a live tail of whatever hasn't been
        // rolled up yet, so these "all_time" figures survive the retention
        // cron instead of silently shrinking as page_views/agent_interactions
        // age out. downloads is the one field that's genuinely unwindowed on
        // purpose: resume_downloads is exempt from the cron (its write path
        // was retired 2026-06-10), so a live COUNT is already exact forever.
        // unique_locations has no rollup column yet (Tier 2, deferred) — it
        // will still shrink post-purge; see .claude/docs/backend.md.
        const allTime = await one(
            `SELECT
               (SELECT COALESCE(SUM(pageviews),0) FROM daily_stats) +
               (SELECT COUNT(*) FROM page_views
                WHERE date(viewed_at,'unixepoch') NOT IN (SELECT day FROM daily_stats)) AS pageviews,

               (SELECT COALESCE(SUM(unique_visitors),0) FROM daily_stats) +
               (SELECT COUNT(DISTINCT visitor_hash) FROM page_views
                WHERE date(viewed_at,'unixepoch') NOT IN (SELECT day FROM daily_stats)) AS unique_visitors,

               (SELECT COUNT(*) FROM resume_downloads) AS downloads,

               (SELECT COALESCE(SUM(conversations),0) FROM daily_stats) +
               (SELECT COUNT(DISTINCT session_id) FROM agent_interactions
                WHERE date(logged_at,'unixepoch') NOT IN (SELECT day FROM daily_stats)) AS conversations,

               (SELECT COUNT(DISTINCT COALESCE(country,'') || '|' || COALESCE(city,''))
                FROM page_views WHERE country IS NOT NULL AND country != '') AS unique_locations,

               (SELECT COALESCE(SUM(tokens_in),0) FROM daily_stats) +
               (SELECT COALESCE(SUM(tokens_input),0) FROM agent_interactions
                WHERE date(logged_at,'unixepoch') NOT IN (SELECT day FROM daily_stats)) AS tokens_in,

               (SELECT COALESCE(SUM(tokens_out),0) FROM daily_stats) +
               (SELECT COALESCE(SUM(tokens_output),0) FROM agent_interactions
                WHERE date(logged_at,'unixepoch') NOT IN (SELECT day FROM daily_stats)) AS tokens_out,

               (SELECT COALESCE(SUM(send_failures),0) FROM daily_stats) +
               (SELECT COUNT(*) FROM send_failures
                WHERE date(failed_at,'unixepoch') NOT IN (SELECT day FROM daily_stats)) AS send_failures`
        );

        const win = await one(
            `SELECT
               (SELECT COUNT(*) FROM page_views WHERE viewed_at > ?1)                         AS pageviews,
               (SELECT COUNT(DISTINCT visitor_hash) FROM page_views WHERE viewed_at > ?1)      AS unique_visitors,
               (SELECT COUNT(*) FROM resume_downloads WHERE downloaded_at > ?1)                AS downloads,
               (SELECT COUNT(DISTINCT session_id) FROM agent_interactions WHERE logged_at > ?1) AS conversations,
               (SELECT COUNT(*) FROM agent_interactions WHERE logged_at > ?1)                  AS agent_turns,
               (SELECT COUNT(*) FROM agent_interactions WHERE logged_at > ?1 AND status != 'ok') AS agent_errors,
               (SELECT COUNT(DISTINCT COALESCE(country,'') || '|' || COALESCE(city,''))
                FROM page_views WHERE viewed_at > ?1 AND country IS NOT NULL AND country != '') AS unique_locations,
               (SELECT COALESCE(SUM(tokens_input),0)  FROM agent_interactions WHERE logged_at > ?1) AS tokens_in,
               (SELECT COALESCE(SUM(tokens_output),0) FROM agent_interactions WHERE logged_at > ?1) AS tokens_out,
               (SELECT COUNT(*) FROM send_failures WHERE failed_at > ?1) AS send_failures`,
            winStart
        );

        const prev = await one(
            `SELECT
               (SELECT COUNT(*) FROM page_views WHERE viewed_at > ?1 AND viewed_at <= ?2)                    AS pageviews,
               (SELECT COUNT(DISTINCT visitor_hash) FROM page_views WHERE viewed_at > ?1 AND viewed_at <= ?2) AS unique_visitors,
               (SELECT COUNT(*) FROM resume_downloads WHERE downloaded_at > ?1 AND downloaded_at <= ?2)       AS downloads,
               (SELECT COUNT(DISTINCT session_id) FROM agent_interactions WHERE logged_at > ?1 AND logged_at <= ?2) AS conversations,
               (SELECT COUNT(DISTINCT COALESCE(country,'') || '|' || COALESCE(city,''))
                FROM page_views WHERE viewed_at > ?1 AND viewed_at <= ?2 AND country IS NOT NULL AND country != '') AS unique_locations,
               (SELECT COALESCE(SUM(tokens_input),0)  FROM agent_interactions WHERE logged_at > ?1 AND logged_at <= ?2) AS tokens_in,
               (SELECT COALESCE(SUM(tokens_output),0) FROM agent_interactions WHERE logged_at > ?1 AND logged_at <= ?2) AS tokens_out,
               (SELECT COUNT(*) FROM send_failures WHERE failed_at > ?1 AND failed_at <= ?2) AS send_failures`,
            prevStart, winStart
        );

        const topQ = await env.DB.prepare(
            `SELECT question, COUNT(*) AS count
             FROM agent_interactions
             WHERE logged_at > ? AND question != ''
             GROUP BY question
             ORDER BY count DESC, MAX(logged_at) DESC
             LIMIT 10`
        ).bind(winStart).all();

        const geo = await env.DB.prepare(
            `SELECT country, city, COUNT(*) AS count
             FROM page_views
             WHERE viewed_at > ? AND country IS NOT NULL AND country != ''
             GROUP BY country, city
             ORDER BY count DESC
             LIMIT 8`
        ).bind(winStart).all();

        const errs = await env.DB.prepare(
            `SELECT question, status, error_message, logged_at
             FROM agent_interactions
             WHERE logged_at > ? AND status != 'ok'
             ORDER BY logged_at DESC
             LIMIT 8`
        ).bind(winStart).all();

        // Which model(s) actually answered this window — Atlas cascades on
        // 429/503, so this can be more than one. Replaces a hardcoded model
        // name in the digest that was wrong (named a different model than
        // the one actually configured).
        const chatModels = await env.DB.prepare(
            `SELECT model, COUNT(*) AS count
             FROM agent_interactions
             WHERE logged_at > ? AND model IS NOT NULL
             GROUP BY model
             ORDER BY count DESC`
        ).bind(winStart).all();

        return json({
            ok: true,
            window_days: days,
            all_time: allTime,
            window: win,
            prev_window: prev,
            top_questions: topQ.results || [],
            geo: geo.results || [],
            errors: errs.results || [],
            chat_models: chatModels.results || []
        }, 200, {});
    } catch (err) {
        console.error("[ambient] stats query failed", err);
        return json({ ok: false, error: "Internal" }, 500, {});
    }
}

// ─── Pageview beacon (public) ─────────────────────────────────────────────────

// Known crawler/bot user-agents to drop so analytics reflect real humans.
const BOT_UA_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|vkshare|whatsapp|telegram|preview|monitor|lighthouse|headless|curl|wget|python-requests|axios|go-http/i;

// POST /api/pageview — cookieless pageview beacon. Body: { path, referrer }.
// Public, CORS-gated to the site origins. Stores one page_views row with geo
// from request.cf and a daily-rotating visitor_hash.
// Always returns 204 — a beacon must never surface errors to the page.
async function handlePageview(request, env, origin, allowed, corsHeaders) {
    // Beacon is fire-and-forget; quietly ignore disallowed origins / bots.
    if (!origin || !allowed.includes(origin)) {
        return new Response(null, { status: 204, headers: corsHeaders });
    }
    const ua = request.headers.get("User-Agent") || "";
    if (!ua || BOT_UA_RE.test(ua)) {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    let body = {};
    try { body = await request.json(); } catch (_) { body = {}; }

    const path = String(body?.path || "/").slice(0, 256);
    // Same id the chat widget already generates client-side. Aggregate-only
    // by policy: rolled up into daily_stats' pageview_sessions* columns, never
    // joined to email/name at the row level in any shipped query — see
    // .claude/docs/backend.md.
    const sessionId = body?.sessionId ? String(body.sessionId).slice(0, 128) : null;
    let referrer = "";
    try {
        const ref = String(body?.referrer || "");
        referrer = ref ? new URL(ref).hostname.slice(0, 128) : "";
    } catch (_) { referrer = ""; }

    const cf = request.cf || {};
    const country = (cf.country || "").slice(0, 8) || null;
    const region = (cf.region || "").slice(0, 64) || null;
    const city = (cf.city || "").slice(0, 64) || null;

    const ip = request.headers.get("CF-Connecting-IP") || "";
    const utcDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    let visitorHash = null;
    try {
        if (ip) visitorHash = (await sha256hex(`${ip}|${ua}|${utcDate}`)).slice(0, 16);
    } catch (_) { visitorHash = null; }

    const at = Math.floor(Date.now() / 1000);
    try {
        await env.DB.prepare(
            `INSERT INTO page_views (viewed_at, path, referrer, country, region, city, visitor_hash, session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(at, path, referrer || null, country, region, city, visitorHash, sessionId).run();
    } catch (err) {
        console.error("[pageview] insert failed", err);
    }
    return new Response(null, { status: 204, headers: corsHeaders });
}

// ─── Agent log (admin read) ───────────────────────────────────────────────────

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
                    citations_count, suggestions_count, cta,
                    country, region, city, model, model_fallback_depth,
                    thinking_tokens, had_thinking
             FROM agent_interactions ORDER BY logged_at DESC LIMIT 200`
        ).all();
        return json({ ok: true, leads: results }, 200, corsHeaders);
    } catch (err) {
        console.error("[agent-log] D1 read failed", err);
        return json({ ok: false, error: "Internal" }, 500, corsHeaders);
    }
}
