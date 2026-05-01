// shader.js — WebGL hero background (curl-noise gradient).
// Implementation lives in spec 02 (hero-shader).
//
// Contract:
//   export function initHeroShader(canvas: HTMLCanvasElement): { destroy(): void }
//
// Lazy-loaded by main.js when the [data-section="hero"] node is in view.

export function initHeroShader(canvas) {
    console.info("[shader] init stub — implement in spec 02", canvas);
    return { destroy() {} };
}
