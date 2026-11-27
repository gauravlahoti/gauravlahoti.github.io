// Spec 110: the visitor_hash derivation. Run with
//   node --test 'backend/test/**/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    PERIOD_ANCHOR, PERIOD_SECONDS, ipPrefix, isOwnerSession, reportPeriod, uaFamily, visitorKey,
} from "../src/visitor-key.js";

const CHROME_ANDROID_130 = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36";
const CHROME_ANDROID_131 = CHROME_ANDROID_130.replace("130.0.6723.58", "131.0.6778.39");
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

test("ipPrefix: IPv4 keeps the /24", () => {
    assert.equal(ipPrefix("49.36.120.7"), "49.36.120");
    assert.equal(ipPrefix("49.36.120.250"), "49.36.120");
    assert.equal(ipPrefix("::ffff:49.36.120.7"), "49.36.120");
});

test("ipPrefix: IPv6 keeps the /48, compressed or not", () => {
    assert.equal(ipPrefix("2401:4900:1c2a:5f3e:a1b2:c3d4:e5f6:0789"), "2401:4900:1c2a");
    assert.equal(ipPrefix("2401:4900:1c2a::1"), "2401:4900:1c2a");
    assert.equal(ipPrefix("2401:4900::1"), "2401:4900:0");
    assert.equal(ipPrefix("2401:04900:1c2a::1"), "");          // 5-digit hextet
    assert.equal(ipPrefix("2401:0db8:0001:ffff::"), "2401:db8:1");
    assert.equal(ipPrefix("fe80::1%en0"), "fe80:0:0");
});

test("ipPrefix: junk gives no key", () => {
    assert.equal(ipPrefix(""), "");
    assert.equal(ipPrefix(undefined), "");
    assert.equal(ipPrefix("not-an-ip"), "");
    assert.equal(ipPrefix("1::2::3"), "");
});

test("uaFamily: browser + platform, no versions", () => {
    assert.equal(uaFamily(CHROME_ANDROID_130), "chrome|android");
    assert.equal(uaFamily(CHROME_ANDROID_131), "chrome|android");
    assert.equal(uaFamily(SAFARI_IOS), "safari|ios");
    assert.equal(uaFamily(CHROME_MAC), "chrome|mac");
    assert.equal(uaFamily(EDGE_WIN), "edge|windows");
    assert.equal(uaFamily(FIREFOX_LINUX), "firefox|linux");
    assert.equal(uaFamily(""), "other|other");
});

test("reportPeriod rotates at Monday 08:00 IST, not at UTC midnight", () => {
    const mon0800ist = PERIOD_ANCHOR + 46 * PERIOD_SECONDS;     // some later Monday 02:30 UTC
    assert.equal(new Date(mon0800ist * 1000).toISOString().slice(11, 16), "02:30");
    assert.equal(new Date(mon0800ist * 1000).getUTCDay(), 1);
    const p = reportPeriod(mon0800ist);
    assert.equal(reportPeriod(mon0800ist - 1), p - 1);
    // A Mon 08:00 IST → Thu 08:00 IST report crosses 3 UTC midnights in one period.
    assert.equal(reportPeriod(mon0800ist + 3 * 86400), p);
    assert.equal(reportPeriod(mon0800ist + PERIOD_SECONDS - 1), p);
});

test("visitorKey: one person across a week of churn is one visitor", async () => {
    const t = PERIOD_ANCHOR + 46 * PERIOD_SECONDS + 3600;
    const base = await visitorKey({ ip: "49.36.120.7", ua: CHROME_ANDROID_130, now: t, secret: "s" });
    assert.match(base, /^[0-9a-f]{16}$/);
    // next UTC day, new IP in the same /24, browser auto-updated
    assert.equal(await visitorKey({ ip: "49.36.120.99", ua: CHROME_ANDROID_131, now: t + 86400, secret: "s" }), base);
});

test("visitorKey: different period, network, device or secret give different hashes", async () => {
    const t = PERIOD_ANCHOR + 46 * PERIOD_SECONDS + 3600;
    const k = (o) => visitorKey({ ip: "49.36.120.7", ua: CHROME_ANDROID_130, now: t, secret: "s", ...o });
    const base = await k({});
    assert.notEqual(await k({ now: t + PERIOD_SECONDS }), base);
    assert.notEqual(await k({ ip: "49.36.121.7" }), base);
    assert.notEqual(await k({ ua: SAFARI_IOS }), base);
    assert.notEqual(await k({ secret: "other" }), base);
    assert.equal(await k({ ip: "" }), null);
});

test("isOwnerSession", () => {
    assert.equal(isOwnerSession("owner-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"), true);
    assert.equal(isOwnerSession("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"), false);
    assert.equal(isOwnerSession(null), false);
});
