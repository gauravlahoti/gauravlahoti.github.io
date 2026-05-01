// main.js — entry point. Orchestrates module init in the right order.
// Spec 01 wires up Lenis + GSAP. Each visualization module lazy-loads
// when its anchor section enters the viewport.

(async function bootstrap() {
    console.info("[portfolio] scaffolding loaded — spec 01 not yet implemented");

    try {
        const profile = await fetch("assets/js/data/profile.json").then(r => r.json());
        document.title = `${profile.name} — ${profile.title}`;
    } catch (err) {
        console.warn("[portfolio] profile.json missing or invalid", err);
    }
})();
