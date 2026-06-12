// reveal.js — lightweight scroll-reveal for [data-reveal] elements.
// Uses globally-loaded GSAP + ScrollTrigger (already a CDN dependency).
// Call initReveal() once on idle; elements start hidden via JS set so
// no-JS users always see content.
export function initReveal(root = document) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const gsap = window.gsap;
    const ScrollTrigger = window.ScrollTrigger;
    if (!gsap || !ScrollTrigger) return;

    const targets = Array.from(root.querySelectorAll("[data-reveal]"));
    if (!targets.length) return;

    gsap.set(targets, { opacity: 0, y: 16 });

    ScrollTrigger.batch(targets, {
        start: "top 88%",
        once: true,
        onEnter(els) {
            gsap.to(els, {
                opacity: 1,
                y: 0,
                duration: 0.55,
                stagger: 0.08,
                ease: "power3.out",
                clearProps: "opacity,transform",
            });
        },
    });
}
