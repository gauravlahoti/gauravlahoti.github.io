// owner.js — lets the site owner leave their own visits out of the numbers
// (spec 110).
//
// Open any page with ?owner=1 once and this browser is marked as the owner's;
// ?owner=0 clears it. While marked, every session id the site mints is
// prefixed "owner-". The backend drops those page views and widget events,
// and keeps the owner's Atlas chats for debugging but out of every visitor
// count. Nothing is sent anywhere to set the flag, and nothing visible changes
// on the page.
//
// Storage can throw (private windows, blocked site data), so every access is
// guarded. If it does, the browser is simply counted like anyone else's.

const KEY = "gl_owner";
const PREFIX = "owner-";

function applyUrlFlag(win) {
    try {
        const url = new URL(win.location.href);
        const flag = url.searchParams.get("owner");
        if (flag !== "1" && flag !== "0") return;
        if (flag === "1") win.localStorage.setItem(KEY, "1");
        else win.localStorage.removeItem(KEY);
        // Drop the param so the link can't be copied and shared by mistake.
        url.searchParams.delete("owner");
        win.history.replaceState(win.history.state, "", url.pathname + url.search + url.hash);
    } catch (_) {
        // storage or history unavailable: leave things as they are
    }
}

/** Is this browser marked as the site owner's? */
export function isOwner(win = globalThis) {
    try {
        return win.localStorage?.getItem(KEY) === "1";
    } catch (_) {
        return false;
    }
}

/** Prefix a freshly minted session id when this browser is the owner's. */
export function tagSessionId(id, win = globalThis) {
    if (typeof id !== "string" || id.startsWith(PREFIX)) return id;
    return isOwner(win) ? PREFIX + id : id;
}

if (typeof window !== "undefined" && window.location) {
    applyUrlFlag(window);
    if (isOwner(window)) console.info("[owner] analytics off for this browser (?owner=0 to undo)");
}
