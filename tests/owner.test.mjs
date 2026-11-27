// Spec 110: the owner opt-out tags session ids, and never breaks when storage
// is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwner, tagSessionId } from "../assets/js/owner.js";

const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

function fakeWin(store) {
    return {
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
    };
}

test("visitors' session ids are untouched", () => {
    const win = fakeWin({});
    assert.equal(isOwner(win), false);
    assert.equal(tagSessionId(ID, win), ID);
});

test("the owner's session ids get the owner- prefix, once", () => {
    const win = fakeWin({ gl_owner: "1" });
    assert.equal(isOwner(win), true);
    assert.equal(tagSessionId(ID, win), `owner-${ID}`);
    assert.equal(tagSessionId(`owner-${ID}`, win), `owner-${ID}`);
    // still passes the Worker's widget-event check and the agent-log length cap
    assert.match(tagSessionId(ID, win), /^[A-Za-z0-9_-]{8,64}$/);
});

test("storage that throws means 'not the owner', never an exception", () => {
    const win = { get localStorage() { throw new Error("SecurityError"); } };
    assert.equal(isOwner(win), false);
    assert.equal(tagSessionId(ID, win), ID);
    assert.equal(isOwner({}), false);
});
