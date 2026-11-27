// visitor-key.js — the page_views.visitor_hash derivation (spec 110), shared by
// the Worker (src/index.js) and the local dev server (local-server.js).
//
// The old hash, sha256(ip|ua|UTC_date), turned one person into several
// "visitors": a new hash every UTC day, on every mobile IP rotation and on
// every browser auto-update. A Mon→Thu Pulse report spans four UTC dates, so
// a daily visitor counted up to four times.
//
// This key is stable for one report week and coarse enough to survive IP
// churn and version bumps:
//   - period: rotates Monday 02:30 UTC (= 08:00 IST, when Pulse runs), so
//     each Mon→Thu and Thu→Mon report window sits inside one period.
//   - ip:     IPv4 /24, IPv6 /48. Never stored, only hashed.
//   - ua:     browser family + platform, no version numbers.
//   - secret: VISITOR_HASH_SECRET, so the small input space can't be
//     brute-forced back to a network from a D1 dump.
//
// Known limits: a phone and a laptop are still two visitors, and two people on
// the same /24 with the same browser and OS count as one. Fine for a digest.
//
// widget_events deliberately does NOT use this: its rate cap stays on the
// daily full-IP hash, so one office NAT can't exhaust the cap for everyone.

// Monday 5 Jan 2026, 02:30 UTC = 08:00 IST.
export const PERIOD_ANCHOR = Date.UTC(2026, 0, 5, 2, 30) / 1000;
export const PERIOD_SECONDS = 7 * 24 * 60 * 60;

// Rows from this moment on carry the spec 110 hash. Before it, visitor_hash
// is the old daily one, and the two can't be compared (Pulse uses this to
// skip the visitor delta across the cutover). Set at deploy, rounded up: a
// late value only shows "new method" a little longer, an early one fakes a ▼.
export const VISITOR_HASH_V2_SINCE = Date.UTC(2026, 10, 27, 4, 45) / 1000;  // 2026-11-27 04:45 UTC, just after the Worker deploy

const DEV_SECRET = "local-dev-visitor-salt";

/** Report period index for a unix-seconds timestamp. */
export function reportPeriod(nowSec) {
    return Math.floor((nowSec - PERIOD_ANCHOR) / PERIOD_SECONDS);
}

/** Expand an IPv6 address to its 8 hextets, or null if it doesn't parse. */
function ipv6Hextets(ip) {
    const addr = ip.split("%")[0].toLowerCase();
    const halves = addr.split("::");
    if (halves.length > 2) return null;
    const part = (s) => (s ? s.split(":") : []);
    const head = part(halves[0]);
    const tail = halves.length === 2 ? part(halves[1]) : [];
    // An embedded IPv4 tail (::ffff:1.2.3.4) is two hextets.
    const last = tail.length ? tail[tail.length - 1] : head[head.length - 1];
    const v4tail = last && last.includes(".") ? 1 : 0;
    const fill = 8 - head.length - tail.length - v4tail;
    if (halves.length === 1 && fill !== 0) return null;
    if (fill < 0) return null;
    const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
    if (!all.slice(0, 3).every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
    return all.map((h) => (h.includes(".") ? h : h.replace(/^0+(?=.)/, "")));
}

/** Coarse network key: IPv4 /24 ("1.2.3"), IPv6 /48 ("2401:4900:1c2a"). */
export function ipPrefix(ip) {
    if (typeof ip !== "string" || !ip) return "";
    const s = ip.trim();
    const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    const v4 = mapped ? mapped[1] : s;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.split(".").slice(0, 3).join(".");
    const hextets = ipv6Hextets(s);
    return hextets ? hextets.slice(0, 3).join(":") : "";
}

/** Browser family + platform from a User-Agent, versions dropped. */
export function uaFamily(ua) {
    const u = String(ua || "");
    let browser = "other";
    if (/Edg(e|A|iOS)?\//.test(u)) browser = "edge";
    else if (/OPR\/|Opera/.test(u)) browser = "opera";
    else if (/SamsungBrowser\//.test(u)) browser = "samsung";
    else if (/Firefox\/|FxiOS\//.test(u)) browser = "firefox";
    else if (/Chrome\/|CriOS\//.test(u)) browser = "chrome";
    else if (/Safari\//.test(u)) browser = "safari";

    let platform = "other";
    if (/Android/.test(u)) platform = "android";
    else if (/iPhone|iPad|iPod/.test(u)) platform = "ios";
    else if (/CrOS/.test(u)) platform = "chromeos";
    else if (/Windows/.test(u)) platform = "windows";
    else if (/Macintosh|Mac OS X/.test(u)) platform = "mac";
    else if (/Linux/.test(u)) platform = "linux";
    return `${browser}|${platform}`;
}

async function sha256hex(input) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The spec 110 visitor_hash, or null when there's no IP to key on.
 * @param {{ip: string, ua: string, now: number, secret?: string}} p  now = unix seconds
 */
export async function visitorKey({ ip, ua, now, secret }) {
    const net = ipPrefix(ip);
    if (!net) return null;
    const salt = secret || DEV_SECRET;
    return (await sha256hex(`${salt}|${reportPeriod(now)}|${net}|${uaFamily(ua)}`)).slice(0, 16);
}

// ── Owner traffic (spec 110) ─────────────────────────────────────────────────
// The site owner opts their browser out with ?owner=1 (assets/js/owner.js),
// which prefixes every session id with "owner-". Page views and widget events
// from those sessions are dropped at ingest; their Atlas turns are kept (the
// transcripts help debug Atlas) but left out of every visitor-facing count.
export const OWNER_PREFIX = "owner-";

export function isOwnerSession(sessionId) {
    return typeof sessionId === "string" && sessionId.startsWith(OWNER_PREFIX);
}

/** SQL predicate: this agent_interactions row is a real visitor's. A constant. */
export const NOT_OWNER = "COALESCE(session_id, '') NOT LIKE 'owner-%'";
