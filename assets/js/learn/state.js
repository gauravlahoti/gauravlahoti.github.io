// learn/state.js — pure state machine + localStorage persistence (no DOM).

const STORAGE_KEY = "learn:v1";

function freshState() {
    return {
        screen: "intro",       // "intro" | "stage" | "recap"
        character: null,       // "sparkfist" | "hopper"
        mode: null,            // "tech" | "nontech"
        stageIndex: 0,
        score: 0,
        answers: {},           // { [stageId]: { correct: bool, attempts: number } }
        completed: false,
    };
}

// Read a saved game. Returns null if none / invalid / storage unavailable.
export function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object") return null;
        // Minimal shape guard.
        if (!("screen" in data) || !("stageIndex" in data)) return null;
        return { ...freshState(), ...data };
    } catch (err) {
        console.warn("[learn] could not read saved progress", err);
        return null;
    }
}

function persist(state) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
        // Private mode / disabled storage — keep playing in-memory.
        console.warn("[learn] could not save progress", err);
    }
}

export function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* no-op */ }
}

// A tiny observable store. subscribe(fn) → fn(state) on every change.
export function createStore(initial) {
    let state = initial || freshState();
    const listeners = new Set();

    function emit() {
        persist(state);
        for (const fn of listeners) fn(state);
    }

    return {
        get state() { return state; },

        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },

        // Patch + emit.
        set(patch) {
            state = { ...state, ...patch };
            emit();
        },

        pickCharacter(id) { this.set({ character: id }); },
        pickMode(id) { this.set({ mode: id }); },

        start() {
            this.set({ screen: "stage", stageIndex: 0, score: 0, answers: {}, completed: false });
        },

        // Resume an in-progress game (no reset).
        resume() {
            if (state.screen === "recap") { this.set({ screen: "stage" }); }
            else { emit(); }
        },

        // Record an attempt. meta: { stageId, correct, points }.
        award({ stageId, correct, points }) {
            const prev = state.answers[stageId] || { correct: false, attempts: 0 };
            const answers = {
                ...state.answers,
                [stageId]: { correct: correct || prev.correct, attempts: prev.attempts + 1 },
            };
            state = { ...state, answers, score: state.score + (points || 0) };
            emit();
        },

        // Move to the next stage, or to the recap if finished.
        advance(stageCount) {
            const next = state.stageIndex + 1;
            if (next >= stageCount) {
                this.set({ screen: "recap", completed: true });
            } else {
                this.set({ stageIndex: next });
            }
        },

        // Replay — back to intro, keep character + mode preselected.
        replay() {
            state = { ...freshState(), character: state.character, mode: state.mode };
            emit();
        },

        // Replay in the opposite content mode.
        switchMode() {
            const flipped = state.mode === "tech" ? "nontech" : "tech";
            state = { ...freshState(), character: state.character, mode: flipped, screen: "stage" };
            emit();
        },
    };
}
