/**
 * 3D vector-space scene — Three.js v0.160.0 via jsDelivr.
 *
 * The cloud is kept centred on its own centroid (computed each frame from the
 * stored PCA coords) so it rotates around its middle and the camera can be fit
 * to all points + the query — nothing drifts off-frame. Labelled PC axes and a
 * grid give the space orientation; points fly in from the centre one at a time.
 *
 * Exposes: initScene, addPoint, setQuery, highlight, drawLines, buildAxes,
 *          frameAll, resetScene, resize, setAutoRotate.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

let scene, camera, renderer, controls, group, axesGroup, canvasEl;
let corpusPoints = [];   // { mesh, base:Vec3, label, t, targetScale, color }
let queryMarker = null;  // { mesh, ring, label, base:Vec3 }
let lineSegs = null;
let autoRotate = true;
let raycaster = null;
let clickHandler = null;
let selectedIndex = null;

/** Register a callback invoked with the clicked chunk index (or null on empty click). */
export function setPointClickHandler(fn) { clickHandler = fn; }

function _selectPoint(index) {
  // restore previously selected point
  if (selectedIndex != null && corpusPoints[selectedIndex]) {
    corpusPoints[selectedIndex].selected = false;
  }
  selectedIndex = index;
  if (index != null && corpusPoints[index]) corpusPoints[index].selected = true;
}

let ORIGIN;
let centroid;            // Vec3, current cloud centroid (data space)
let camDist = 6;

const FLY_DUR = 0.6;     // seconds for a point to fly in

// High-contrast palette for a dark scene — no additive blending anywhere.
const ACCENT  = 0x00e5bb; // teal-mint — corpus default
const SPARSE  = 0x5599ff; // clear blue — lexical matches
const FUSED   = 0xbb88ff; // soft violet — fused winners
const DIM_COL = 0x334d47; // visible-but-muted grey-teal for dimmed points
const QUERY   = 0xffd166; // warm amber — query stands out from mint corpus
const POINT_R = 0.055;    // sphere radius (world units)

export function initScene(canvas) {
  canvasEl = canvas;
  ORIGIN = new THREE.Vector3(0, 0, 0);
  centroid = new THREE.Vector3(0, 0, 0);
  _up = new THREE.Vector3(0, 0.13, 0);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b1512, 8, 32);
  group = new THREE.Group();
  scene.add(group);

  camera = new THREE.PerspectiveCamera(45, _aspect(), 0.01, 200);
  camera.position.set(0, 0.5, camDist);

  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  _resize();
  new ResizeObserver(_resize).observe(canvas);

  // OrbitControls — drag to rotate, scroll to zoom, right-drag to pan.
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;      // slow, calm
  controls.minDistance = 1.5;
  controls.maxDistance = 20;
  controls.enablePan = true;

  // When the user grabs the scene, stop auto-rotation so it stays put.
  canvas.addEventListener("pointerdown", () => {
    controls.autoRotate = false;
    autoRotate = false;
  });

  let paused = false;
  new IntersectionObserver(([e]) => { paused = !e.isIntersecting; }).observe(canvas);

  // Click → raycast to select a point.
  // We only fire if the pointer didn't move (to distinguish drag from click).
  raycaster = new THREE.Raycaster();
  raycaster.params.Mesh = { threshold: 0.08 };
  const ndc = new THREE.Vector2();
  let pointerDownPos = null;
  canvas.addEventListener("pointerdown", (e) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    if (Math.hypot(dx, dy) > 5) return;  // was a drag, not a click
    const r = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(group.children, true);
    const hit = hits.find((h) => h.object?.userData?.pointIndex !== undefined);
    if (hit) {
      _selectPoint(hit.object.userData.pointIndex);
      if (clickHandler) clickHandler(hit.object.userData.pointIndex);
    } else {
      _selectPoint(null);
      if (clickHandler) clickHandler(null);
    }
  });
  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", () => { canvas.style.cursor = "grabbing"; });
  canvas.addEventListener("pointerup",   () => { canvas.style.cursor = "grab"; });

  let last = performance.now();
  let t = 0;
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (paused) return;
    t += dt;

    controls.update();  // handles damping + auto-rotate

    // position each corpus point relative to centroid, with fly-in tween
    for (const p of corpusPoints) {
      if (!p) continue;
      if (p.t < 1) p.t = Math.min(1, p.t + dt / FLY_DUR);
      const e = _easeOut(p.t);
      const target = _local(p.base);
      p.mesh.position.copy(ORIGIN).lerp(target, e);
      const sel = p.selected ? 1.5 : 1;
      p.mesh.scale.setScalar(p.targetScale * sel * e);
      if (p.label) {
        p.label.position.copy(p.mesh.position).add(_up);
        p.label.material.opacity = e * (p.targetScale > 1.1 || p.selected ? 1 : 0.5);
      }
    }

    // query marker — gentle pulse
    if (queryMarker) {
      queryMarker.mesh.position.copy(_local(queryMarker.base));
      const s = 1 + Math.sin(t * 2.5) * 0.12;
      queryMarker.mesh.scale.setScalar(s);
      if (queryMarker.label) queryMarker.label.position.copy(queryMarker.mesh.position).add(_up);
    }

    if (lineSegs) _refreshLines();

    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}

/** Add a corpus point — solid opaque sphere, no additive blending. */
export function addPoint(x, y, z, index, color = ACCENT) {
  const base = new THREE.Vector3(x, y, z);

  // Outer sphere — the visible dot
  const geo = new THREE.SphereGeometry(POINT_R, 14, 10);
  const mat = new THREE.MeshBasicMaterial({ color });
  const sphere = new THREE.Mesh(geo, mat);
  sphere.userData.pointIndex = index;

  // Tiny bright cap to give a sense of depth
  const capGeo = new THREE.SphereGeometry(POINT_R * 0.38, 8, 6);
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
  const cap = new THREE.Mesh(capGeo, capMat);
  cap.position.set(POINT_R * 0.35, POINT_R * 0.45, POINT_R * 0.35);

  const mesh = new THREE.Group();
  mesh.add(sphere);
  mesh.add(cap);
  mesh.position.copy(ORIGIN);
  group.add(mesh);

  const label = _makeLabel(`C${index}`);
  label.scale.set(0.32, 0.16, 1);
  label.position.copy(ORIGIN);
  group.add(label);

  corpusPoints[index] = { mesh, sphere, cap, base, label, t: 0, targetScale: 1, color };
  frameAll();
  return mesh;
}

/** Place / replace the query marker. Coords clamped so far outliers stay framable. */
export function setQuery(x, y, z) {
  const base = new THREE.Vector3(
    _clamp(x, -1.5, 1.5), _clamp(y, -1.5, 1.5), _clamp(z, -1.5, 1.5),
  );
  if (queryMarker) {
    group.remove(queryMarker.mesh);
    if (queryMarker.ring) group.remove(queryMarker.ring);
    if (queryMarker.label) group.remove(queryMarker.label);
  }

  // Query marker: amber sphere, distinctly larger than corpus points
  const qGeo  = new THREE.SphereGeometry(POINT_R * 1.5, 16, 12);
  const qMat  = new THREE.MeshBasicMaterial({ color: QUERY });
  const qMesh = new THREE.Mesh(qGeo, qMat);
  qMesh.userData.isQuery = true;
  const mesh = new THREE.Group();
  mesh.add(qMesh);
  group.add(mesh);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.15, 28),
    new THREE.MeshBasicMaterial({ color: QUERY, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  );
  group.add(ring);

  const label = _makeLabel("query", "#ffffff");
  label.scale.set(0.5, 0.24, 1);
  group.add(label);

  queryMarker = { mesh, ring, label, base };
  frameAll();
}

/**
 * Build labelled PC axes + a reference grid.
 * @param {number[]} ev  explained-variance ratios [pc1, pc2, pc3]
 */
export function buildAxes(ev = []) {
  clearAxes();
  axesGroup = new THREE.Group();
  const L = 1.4;
  const defs = [
    { dir: new THREE.Vector3(1, 0, 0), col: 0xff5c5c, name: "PC1", v: ev[0] },
    { dir: new THREE.Vector3(0, 1, 0), col: 0x6fb1ff, name: "PC2", v: ev[1] },
    { dir: new THREE.Vector3(0, 0, 1), col: 0xc7a6ff, name: "PC3", v: ev[2] },
  ];
  for (const a of defs) {
    const end = a.dir.clone().multiplyScalar(L);
    const neg = a.dir.clone().multiplyScalar(-L);
    const geo = new THREE.BufferGeometry().setFromPoints([neg, end]);
    axesGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: a.col, transparent: true, opacity: 0.45 })));

    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.035, 0.12, 10),
      new THREE.MeshBasicMaterial({ color: a.col }),
    );
    cone.position.copy(end);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.dir);
    axesGroup.add(cone);

    const pct = a.v != null ? `  ${(a.v * 100).toFixed(0)}%` : "";
    const label = _makeLabel(a.name + pct, "#" + a.col.toString(16).padStart(6, "0"));
    label.scale.set(0.62, 0.31, 1);
    label.position.copy(end).add(a.dir.clone().multiplyScalar(0.2));
    axesGroup.add(label);
  }

  const grid = new THREE.GridHelper(3.4, 14, 0x2a6157, 0x14302c);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  grid.position.y = -1.5;          // floor beneath the cloud
  axesGroup.add(grid);

  group.add(axesGroup);
}

/**
 * Dim the whole cloud, then light up matched chunks.
 * @param {number[]} indices
 * @param {"dense"|"sparse"|"fused"} level
 */
export function highlight(indices, level = "fused") {
  const col = level === "fused" ? FUSED : level === "sparse" ? SPARSE : ACCENT;
  for (const p of corpusPoints) {
    if (!p) continue;
    p.sphere.material.color.setHex(DIM_COL);
    p.targetScale = 1;
  }
  for (const idx of indices) {
    const p = corpusPoints[idx];
    if (!p) continue;
    p.sphere.material.color.setHex(col);
    p.targetScale = 1.6;
  }
}

/**
 * Draw lines from the query marker to matched chunks, opacity ∝ similarity.
 * @param {Array<{index:number, weight:number}>} targets  weight in [0,1]
 */
let _lineTargets = [];
let lineLabels = [];
export function drawLines(targets) {
  _lineTargets = (targets || []).filter((t) => corpusPoints[t.index]);
  if (lineSegs) { group.remove(lineSegs); lineSegs = null; }
  _clearLineLabels();
  if (!queryMarker || !_lineTargets.length) return;
  _buildLines();
}

function _clearLineLabels() {
  for (const ll of lineLabels) group.remove(ll.sprite);
  lineLabels = [];
}

export function frameAll() {
  const pts = [];
  for (const p of corpusPoints) if (p) pts.push(p.base);
  if (queryMarker) pts.push(queryMarker.base);
  if (!pts.length) return;

  const box = new THREE.Box3();
  pts.forEach((v) => box.expandByPoint(v));
  centroid.copy(box.getCenter(new THREE.Vector3()));

  // bounding radius from centroid
  let r = 0.6;
  pts.forEach((v) => { r = Math.max(r, v.distanceTo(centroid)); });
  camDist = r * 2.8 + 2;

  if (scene.fog) {
    scene.fog.near = Math.max(2, camDist * 0.6);
    scene.fog.far = camDist * 3;
  }

  // Recentre OrbitControls so orbiting rotates around the cloud centre.
  if (controls) {
    const local = _local(centroid.clone().add(centroid));
    controls.target.copy(new THREE.Vector3(0, 0, 0));
    controls.update();
  }
  // Push camera out to fit — only if it's too close.
  if (camera && camera.position.length() < camDist * 0.8) {
    camera.position.setLength(camDist);
  }
}

export function resetScene() {
  if (!group) return;
  for (const p of corpusPoints) {
    if (!p) continue;
    group.remove(p.mesh);
    if (p.label) group.remove(p.label);
  }
  corpusPoints = [];
  if (queryMarker) {
    group.remove(queryMarker.mesh);
    if (queryMarker.label) group.remove(queryMarker.label);
    queryMarker = null;
  }
  if (lineSegs) { group.remove(lineSegs); lineSegs = null; }
  _clearLineLabels();
  _lineTargets = [];
  clearAxes();
  selectedIndex = null;
  centroid.set(0, 0, 0);
  camDist = 6;
  group.rotation.set(0, 0, 0);
}

export function clearAxes() {
  if (axesGroup) { group.remove(axesGroup); axesGroup = null; }
}

export function resize() { _resize(); }
export function setAutoRotate(on) {
  autoRotate = on;
  if (controls) controls.autoRotate = on;
}

// ── helpers ───────────────────────────────────────────────────────

let _up;
function _local(base) {
  return base.clone().sub(centroid);
}

function _buildLines() {
  const positions = [];
  const colors = [];
  const base = new THREE.Color(ACCENT);
  for (const { index } of _lineTargets) positions.push(0, 0, 0, 0, 0, 0);
  for (const { weight } of _lineTargets) {
    const w = _clamp(weight ?? 0.5, 0.2, 1);
    for (let k = 0; k < 2; k++) colors.push(base.r * w, base.g * w, base.b * w);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  lineSegs = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.75,
  }));
  group.add(lineSegs);
  _refreshLines();
}

function _refreshLines() {
  if (!lineSegs || !queryMarker) return;
  const pos = lineSegs.geometry.attributes.position.array;
  const q = _local(queryMarker.base);
  let i = 0;
  for (const { index } of _lineTargets) {
    const p = corpusPoints[index];
    if (!p) continue;
    const tp = _local(p.base);
    pos[i++] = q.x; pos[i++] = q.y; pos[i++] = q.z;
    pos[i++] = tp.x; pos[i++] = tp.y; pos[i++] = tp.z;
  }
  lineSegs.geometry.attributes.position.needsUpdate = true;
}

function _resize() {
  if (!renderer || !canvasEl) return;
  const w = canvasEl.clientWidth || 1;
  const h = canvasEl.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function _aspect() {
  return (canvasEl?.clientWidth || 1) / (canvasEl?.clientHeight || 1);
}

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function _easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function _makeLabel(text, color = "#9a9a9a") {
  const c = document.createElement("canvas");
  c.width = 160; c.height = 64;
  const ctx = c.getContext("2d");
  ctx.font = "600 28px JetBrains Mono, monospace";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 80, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.5, 0.2, 1);
  return sprite;
}
