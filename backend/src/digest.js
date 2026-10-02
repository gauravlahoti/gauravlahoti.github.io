// Pulse v2 digest data (spec 84), shared by the Worker (src/index.js) and the
// local dev server (local-server.js), so the two never drift.
//
// Everything here is aggregate: counts, medians, hostnames. No question text,
// IPs or emails leave D1 through these queries.
//
// `run(sql, binds)` is the caller's adapter and returns an array of rows:
//   Worker: (sql, b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || [])
//   Node:   (sql, b) => db.prepare(sql).all(...b)

// Statuses that are not failures, as a SQL list (spec 82). A visitor talking
// over the avatar ends the turn on purpose. A constant, never user input.
export const NOT_AN_ERROR = "('ok', 'interrupted', 'cancelled')";

// Rows logged before migration 013 have no reply_mode; the avatar's Live model
// is the only reliable tell, so everything else counts as text.
const MODE = `COALESCE(reply_mode, CASE WHEN model LIKE '%-live%' THEN 'avatar' ELSE 'text' END)`;

// Same-site referrers are internal navigation, not a traffic source.
const OWN_HOSTS = new Set(["gauravlahoti.dev", "www.gauravlahoti.dev", "gauravlahoti.github.io"]);

export function median(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

export function referrerHost(ref) {
    if (!ref) return "direct";
    try {
        const host = new URL(ref).hostname.replace(/^www\./, "").toLowerCase();
        if (OWN_HOSTS.has(host) || OWN_HOSTS.has("www." + host)) return null;
        // LinkedIn arrives as linkedin.com, lnkd.in and the android-app scheme.
        if (host.endsWith("linkedin.com") || host === "lnkd.in" || host === "com.linkedin.android") return "linkedin";
        if (/(^|\.)google\./.test(host) || host === "com.google.android.gm") return "google";
        return host;
    } catch (_) {
        return ref.startsWith("android-app://com.linkedin") ? "linkedin" : "other";
    }
}

async function modes(run, from, to) {
    const rows = await run(
        `SELECT ${MODE} AS mode, COUNT(*) AS turns, COUNT(DISTINCT session_id) AS sessions,
                COALESCE(SUM(avatar_seconds), 0) AS avatar_seconds
         FROM agent_interactions WHERE logged_at > ? AND logged_at <= ?
         GROUP BY 1 ORDER BY turns DESC`,
        [from, to]
    );
    const firsts = await run(
        `SELECT ${MODE} AS mode, first_ms FROM agent_interactions
         WHERE logged_at > ? AND logged_at <= ? AND first_ms IS NOT NULL
           AND status IN ('ok', 'interrupted')`,
        [from, to]
    );
    const byMode = {};
    for (const r of firsts) (byMode[r.mode] ||= []).push(Number(r.first_ms));
    return rows.map((r) => ({
        mode: r.mode,
        turns: Number(r.turns) || 0,
        sessions: Number(r.sessions) || 0,
        avatar_seconds: Math.round((Number(r.avatar_seconds) || 0) * 10) / 10,
        median_first_ms: median(byMode[r.mode] || []),
    }));
}

/**
 * The spec 84 additions to GET /api/ambient/stats.
 * @param {(sql: string, binds: unknown[]) => Promise<object[]>|object[]} run
 * Everything is bounded to the report period (from, to], spec 84: since the
 * last report, compared with the same span a week earlier (prevFrom, prevTo].
 * The 14-day `daily` series is the one deliberate exception (context).
 * @param {number} from     period start, unix seconds (exclusive)
 * @param {number} to       period end (inclusive)
 * @param {number} prevFrom comparison start
 * @param {number} prevTo   comparison end
 */
export async function digestExtras(run, from, to, prevFrom, prevTo) {
    const winStart = from;   // keeps the queries below readable
    const now = to;
    const r = async (sql, binds) => (await run(sql, binds)) || [];

    const statuses = await r(
        `SELECT status, COUNT(*) AS count FROM agent_interactions
         WHERE logged_at > ? AND logged_at <= ? GROUP BY status ORDER BY count DESC`,
        [winStart, now]
    );

    const pages = await r(
        `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors
         FROM page_views WHERE viewed_at > ? AND viewed_at <= ? AND path IS NOT NULL AND path != ''
         GROUP BY path ORDER BY views DESC LIMIT 6`,
        [winStart, now]
    );

    const refRows = await r(
        `SELECT referrer, COUNT(*) AS views FROM page_views
         WHERE viewed_at > ? AND viewed_at <= ? GROUP BY referrer ORDER BY views DESC LIMIT 300`,
        [winStart, now]
    );
    const hosts = {};
    for (const row of refRows) {
        const host = referrerHost(row.referrer);
        if (host) hosts[host] = (hosts[host] || 0) + Number(row.views || 0);
    }
    const referrers = Object.entries(hosts)
        .map(([source, views]) => ({ source, views }))
        .sort((a, b) => b.views - a.views)
        .slice(0, 5);

    const count = async (sql, binds) => Number((await r(sql, binds))[0]?.n || 0);
    const emails = {
        resumes: await count(`SELECT COUNT(*) AS n FROM resume_sends WHERE sent_at > ? AND sent_at <= ?`, [winStart, now]),
        notes: await count(`SELECT COUNT(*) AS n FROM note_sends WHERE sent_at > ? AND sent_at <= ?`, [winStart, now]),
        // Visitor-facing sends only: Pulse's own digest failures are kind
        // 'digest' and are reported by the scheduler, not as a site problem.
        failures: await count(`SELECT COUNT(*) AS n FROM send_failures WHERE failed_at > ? AND failed_at <= ? AND kind != 'digest'`, [winStart, now]),
    };

    const fallback = (await r(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN model_fallback_depth > 0 THEN 1 ELSE 0 END) AS fell_back
         FROM agent_interactions WHERE logged_at > ? AND logged_at <= ? AND model_fallback_depth IS NOT NULL`,
        [winStart, now]
    ))[0] || {};

    const posts = await r(
        `SELECT post_id, reactions, comments, reposts FROM post_metrics
         ORDER BY COALESCE(reactions, 0) + 2 * COALESCE(comments, 0) + 3 * COALESCE(reposts, 0) DESC
         LIMIT 3`,
        []
    );

    // ── visuals (spec 84): map, country split, 14-day trend, IST hours, funnel ──
    const IST = 19800;          // +05:30, so days and hours read as Gaurav lives them
    const day = 86400;

    // Sessions that talked to Atlas. Aggregate-only join on session_id, the
    // same one daily_stats' pageview_sessions_* columns use.
    const chattedSessions = `SELECT DISTINCT session_id FROM agent_interactions WHERE logged_at > ? AND logged_at <= ?`;

    const geoPoints = await r(
        `SELECT latitude AS lat, longitude AS lon, city, country,
                COUNT(DISTINCT visitor_hash) AS visitors,
                COUNT(DISTINCT CASE WHEN session_id IN (${chattedSessions}) THEN session_id END) AS chatted
         FROM page_views
         WHERE viewed_at > ? AND viewed_at <= ? AND country IS NOT NULL AND country != ''
         GROUP BY latitude, longitude, city, country
         ORDER BY visitors DESC LIMIT 200`,
        [winStart, now, winStart, now]
    );

    const countries = await r(
        `SELECT country, COUNT(DISTINCT visitor_hash) AS visitors FROM page_views
         WHERE viewed_at > ? AND viewed_at <= ? AND country IS NOT NULL AND country != ''
         GROUP BY country ORDER BY visitors DESC LIMIT 12`,
        [winStart, now]
    );

    const dayStart = (Math.floor((now + IST) / day) - 13) * day - IST;   // 14 IST days incl. today
    const pvDays = await r(
        `SELECT date(viewed_at + ${IST}, 'unixepoch') AS day, COUNT(DISTINCT visitor_hash) AS visitors
         FROM page_views WHERE viewed_at >= ? AND viewed_at <= ? GROUP BY 1`,
        [dayStart, now]
    );
    const chatDays = await r(
        `SELECT date(logged_at + ${IST}, 'unixepoch') AS day, COUNT(DISTINCT session_id) AS chats,
                COUNT(DISTINCT CASE WHEN ${MODE} IN ('avatar', 'convo') THEN session_id END) AS avatar_chats
         FROM agent_interactions WHERE logged_at >= ? AND logged_at <= ? GROUP BY 1`,
        [dayStart, now]
    );
    const byDay = {};
    for (let i = 0; i < 14; i++) {
        const d = new Date((dayStart + IST + i * day) * 1000).toISOString().slice(0, 10);
        byDay[d] = { day: d, visitors: 0, chats: 0, avatar_chats: 0 };
    }
    for (const row of pvDays) if (byDay[row.day]) byDay[row.day].visitors = Number(row.visitors) || 0;
    for (const row of chatDays) if (byDay[row.day]) {
        byDay[row.day].chats = Number(row.chats) || 0;
        byDay[row.day].avatar_chats = Number(row.avatar_chats) || 0;
    }

    const hourRows = await r(
        `SELECT CAST(strftime('%H', viewed_at + ${IST}, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS views
         FROM page_views WHERE viewed_at > ? AND viewed_at <= ? GROUP BY 1`,
        [winStart, now]
    );
    const hours = Array.from({ length: 24 }, (_, h) => 0);
    for (const row of hourRows) hours[Number(row.hour)] = Number(row.views) || 0;

    const funnelRow = (await r(
        `SELECT COUNT(DISTINCT session_id) AS sessions,
                COUNT(DISTINCT CASE WHEN session_id IN (${chattedSessions}) THEN session_id END) AS chatted,
                COUNT(DISTINCT CASE WHEN session_id IN (
                    SELECT DISTINCT session_id FROM agent_interactions
                    WHERE logged_at > ? AND logged_at <= ? AND ${MODE} IN ('avatar', 'convo')) THEN session_id END) AS avatar
         FROM page_views WHERE viewed_at > ? AND viewed_at <= ? AND session_id IS NOT NULL`,
        [winStart, now, winStart, now, winStart, now]
    ))[0] || {};

    // Month-to-date model usage, so Cost watch can estimate the Gemini and
    // avatar spend billed to adk-deploy-trail (a billing account the export
    // can't see). Month starts at 00:00 IST on the 1st.
    const istNow = new Date((now + IST) * 1000);
    const monthStart = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1) / 1000 - IST;
    const usage = await r(
        `SELECT COALESCE(model, 'unknown') AS model, COUNT(*) AS turns,
                COALESCE(SUM(tokens_input), 0) AS tokens_in, COALESCE(SUM(tokens_output), 0) AS tokens_out,
                COALESCE(SUM(avatar_seconds), 0) AS avatar_seconds
         FROM agent_interactions WHERE logged_at > ? AND logged_at <= ? GROUP BY 1 ORDER BY turns DESC`,
        [monthStart, now]
    );

    return {
        usage_mtd: usage.map((u) => ({
            model: u.model, turns: Number(u.turns) || 0,
            tokens_in: Number(u.tokens_in) || 0, tokens_out: Number(u.tokens_out) || 0,
            avatar_seconds: Math.round((Number(u.avatar_seconds) || 0) * 10) / 10,
        })),
        geo_points: geoPoints.map((g) => ({
            lat: g.lat === null ? null : Number(g.lat), lon: g.lon === null ? null : Number(g.lon),
            city: g.city, country: g.country,
            visitors: Number(g.visitors) || 0, chatted: Number(g.chatted) || 0,
        })),
        period: { from, to, prev_from: prevFrom, prev_to: prevTo },
        countries: countries.map((c) => ({ country: c.country, visitors: Number(c.visitors) || 0 })),
        daily: Object.values(byDay),
        hours,
        modes: await modes(run, from, to),
        prev_modes: await modes(run, prevFrom, prevTo),
        statuses,
        top_pages: pages,
        top_referrers: referrers,
        emails,
        fallback: { turns: Number(fallback.n || 0), fell_back: Number(fallback.fell_back || 0) },
        top_posts: posts,
        funnel: {
            sessions: Number(funnelRow.sessions) || 0,
            chatted: Number(funnelRow.chatted) || 0,
            avatar: Number(funnelRow.avatar) || 0,
            emailed: emails.resumes + emails.notes,
        },
    };
}

const REPLY_MODES = new Set(["text", "voice", "avatar", "convo"]);

/** Validate and clamp the spec 84 fields of a POST /api/agent-log body. */
export function digestFields(body) {
    const replyMode = REPLY_MODES.has(body?.replyMode) ? body.replyMode : null;
    const secs = Number(body?.avatarSeconds);
    const avatarSeconds = Number.isFinite(secs) && secs >= 0 ? Math.min(secs, 3600) : null;
    const firstMs = Number.isInteger(body?.firstMs) && body.firstMs >= 0 ? Math.min(body.firstMs, 600000) : null;
    return { replyMode, avatarSeconds, firstMs };
}

/** request.cf latitude/longitude (strings) -> number rounded to 0.1 degree
 * (about 11 km, city level), or null. */
export function roundCoord(value, limit) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
    return Math.round(n * 10) / 10;
}

// Spec 84: Pulse sends the exact report period (since the last report) and
// the comparison span (same days a week earlier) as unix seconds. `days`
// stays as the fallback for older callers. Spans are capped at 31 days.
export function reportWindow(url, defaultDays) {
    const now = Math.floor(Date.now() / 1000);
    const int = (k) => {
        const v = Number.parseInt(url.searchParams.get(k) ?? "", 10);
        return Number.isFinite(v) ? v : null;
    };
    const max = 31 * 24 * 60 * 60;
    let from = int("from"), to = int("to");
    if (from !== null && to !== null && to > from && to - from <= max && to <= now + 3600) {
        let prevFrom = int("prev_from"), prevTo = int("prev_to");
        if (!(prevFrom !== null && prevTo !== null && prevTo > prevFrom && prevTo - prevFrom <= max)) {
            prevFrom = from - (to - from); prevTo = from;
        }
        return { from, to, prevFrom, prevTo };
    }
    let days = parseInt(url.searchParams.get("days") || String(defaultDays), 10);
    if (!Number.isFinite(days)) days = defaultDays;
    days = Math.max(1, Math.min(30, days));
    const span = days * 24 * 60 * 60;
    return { from: now - span, to: now, prevFrom: now - 2 * span, prevTo: now - span };
}
