// Cloudflare Worker — resume download gate (Google Sign-In).
// POST /api/resume-download : { credential: <Google ID token JWT> }
//   → verify via Google's tokeninfo endpoint
//   → record verified identity to D1
//   → respond { ok: true, url }
// GET  /api/leads : admin dump (Authorization: Bearer ADMIN_TOKEN).

const ALLOWED_ISS = new Set([
    "accounts.google.com",
    "https://accounts.google.com"
]);

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

        return json({ ok: false, error: "Not found" }, 404, corsHeaders);
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

async function verifyGoogleIdToken(credential, expectedAud) {
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
    if (!res.ok) {
        return { ok: false, status: 401, error: "Token verification failed" };
    }
    let claims;
    try {
        claims = await res.json();
    } catch (_) {
        return { ok: false, status: 401, error: "Token verification failed" };
    }
    if (!claims || claims.error || claims.error_description) {
        return { ok: false, status: 401, error: "Token verification failed" };
    }
    if (!expectedAud || claims.aud !== expectedAud) {
        return { ok: false, status: 401, error: "Audience mismatch" };
    }
    if (!ALLOWED_ISS.has(claims.iss)) {
        return { ok: false, status: 401, error: "Issuer mismatch" };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Number(claims.exp) <= now) {
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

    const ip = request.headers.get("CF-Connecting-IP") || "";
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
