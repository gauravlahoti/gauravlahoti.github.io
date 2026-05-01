// graph.js — interactive 3D knowledge graph.
// Implementation lives in spec 04 (knowledge-graph).
//
// Contract:
//   export function initGraph(container: HTMLElement, data: GraphData): { destroy() }
//
// Falls back to a 2D SVG render on viewports < 768px or when WebGL is
// unavailable. Data shape: { nodes: [{id, type, label}], edges: [{source, target}] }.

export function initGraph(container, data) {
    console.info("[graph] init stub — implement in spec 04", { container, nodes: data?.nodes?.length });
    return { destroy() {} };
}
