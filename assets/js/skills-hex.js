// skills-hex.js — Honeycomb skills showcase with canvas particle swarm

const CDN = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/';
const PC = 55; // particle count

// All inline SVGs have transparent backgrounds and work directly on the dark hex.
const INLINE_SVGS = {
  // 12-blade coral sunburst — Anthropic/Claude official logo mark
  Claude: `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g transform="translate(40,40)" fill="#E07B54">
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(0)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(30)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(60)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(90)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(120)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(150)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(180)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(210)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(240)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(270)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(300)"/>
      <rect x="-3.8" y="-37" width="7.6" height="22" rx="3.8" transform="rotate(330)"/>
    </g>
  </svg>`,
  // AWS: white "aws" wordmark + orange smile arrow — two-tone, transparent bg
  AWS: `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <text x="40" y="36" text-anchor="middle"
      fill="#ffffff" font-family="Arial Black,Arial,sans-serif"
      font-weight="900" font-size="23" letter-spacing="2">aws</text>
    <path d="M17,51 Q40,67 63,51" stroke="#FF9900" stroke-width="5"
      stroke-linecap="round" fill="none"/>
    <path d="M60,47 L64,52 L58,55" stroke="#FF9900" stroke-width="4"
      stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`,
  // ADK: multi-color Google brand — blue/green robot oval + yellow/red code symbols
  ADK: `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true">
    <defs>
      <clipPath id="adk-l"><rect x="0" y="0" width="40" height="80"/></clipPath>
      <clipPath id="adk-r"><rect x="40" y="0" width="40" height="80"/></clipPath>
    </defs>
    <ellipse cx="40" cy="27" rx="28" ry="18" stroke="#4285F4" stroke-width="6" clip-path="url(#adk-l)"/>
    <ellipse cx="40" cy="27" rx="28" ry="18" stroke="#34A853" stroke-width="6" clip-path="url(#adk-r)"/>
    <circle cx="32" cy="27" r="4.5" fill="#4285F4"/>
    <circle cx="48" cy="27" r="4.5" fill="#4285F4"/>
    <path d="M15 53 L9 53 L9 72 L15 72" stroke="#FBBC04" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M28 53 L21 62.5 L28 72" stroke="#EA4335" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M38 53 L31 62.5 L38 72" stroke="#EA4335" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M48 53 L55 62.5 L48 72" stroke="#EA4335" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M58 53 L65 62.5 L58 72" stroke="#EA4335" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
};

// color         = particle/glow color (hex border pulse + canvas sparks)
// tier          = 'primary' | 'secondary' | 'tertiary' — drives visual hierarchy + idle pulse gating
//                 primary   = ADK, GCP, MCP — largest, full color, idle pulse
//                 secondary = Claude, A2A, AWS — medium, full color, subtle glow
//                 tertiary  = LangChain, LangGraph — smallest, muted, reveal on hover
// inlineSvg     = key into INLINE_SVGS — self-contained multi-color SVG, transparent bg
// imgPath       = local PNG file
// imgFilter     = CSS filter on the <img>
// blendMode     = mix-blend-mode on the <img>: "screen" dissolves black/dark BGs into the hex
// removeWhiteBg = canvas pixel pass: strips near-white pixels to alpha=0 (for RGB-only PNGs)
//
// Order matches the 2-4-2 honeycomb traversal: row 1 (top) → row 2 (primary) → row 3 (bottom).
const SKILLS = [
  { name: 'LangChain', tier: 'tertiary',  imgPath: 'assets/img/skills/langchain.png', color: '#1BD96A', imgFilter: 'brightness(0) invert(1)', blendMode: 'normal' },
  { name: 'LangGraph', tier: 'tertiary',  imgPath: 'assets/img/skills/langgraph.png', color: '#1BD96A', imgFilter: 'brightness(0) invert(1)', blendMode: 'normal' },
  { name: 'AWS',       tier: 'secondary', inlineSvg: 'AWS',                           color: '#FF9900' },
  { name: 'Claude',    tier: 'secondary', inlineSvg: 'Claude',                        color: '#E07B54' },
  { name: 'GCP',       tier: 'primary',   imgPath: 'assets/img/skills/gcp.png',       color: '#4285F4', removeWhiteBg: true },
  { name: 'ADK',       tier: 'primary',   inlineSvg: 'ADK',                           color: '#34A853' },
  { name: 'MCP',       tier: 'primary',   imgPath: 'assets/img/skills/mcp.png',       color: '#A78BFA', imgFilter: 'invert(1)', blendMode: 'screen' },
  { name: 'A2A',       tier: 'secondary', imgPath: 'assets/img/skills/a2a.png',       color: '#4285F4', imgFilter: 'invert(1)', blendMode: 'screen' },
];

// 2-4-2 flat-top honeycomb, vertical orientation (2 left / 4 middle / 2 right columns).
// Flat-top hexes tile in vertical columns: same-column step = H, column x-step = 0.75W,
// odd columns offset by H/2. H = W·√3/2 ≈ 0.866W. All neighbors sit at exactly H apart.
// tx is in W units, ty is in H units (top-left of cell bounding box).
const POSITIONS = {
  LangChain: { tx: 0,    ty: 0.5 },
  LangGraph: { tx: 1.5,  ty: 0.5 },
  AWS:       { tx: 0.75, ty: 0   },
  Claude:    { tx: 0.75, ty: 1   },
  GCP:       { tx: 0.75, ty: 2   },
  ADK:       { tx: 0.75, ty: 3   },
  MCP:       { tx: 0,    ty: 2.5 },
  A2A:       { tx: 1.5,  ty: 2.5 },
};

// Center-out reveal anchored on Claude. All direct neighbors (AWS/GCP/LangChain/LangGraph)
// are at distance H; outer cells (ADK/MCP/A2A) at ~2H.
const WAVES = {
  Claude:    0,
  AWS:       120,
  GCP:       120,
  LangChain: 120,
  LangGraph: 120,
  ADK:       240,
  MCP:       240,
  A2A:       240,
};

// SVG cache for Simple Icons CDN fetches
const _svgCache = new Map();

async function fetchSvgIcon(skill) {
  if (_svgCache.has(skill.slug)) return _svgCache.get(skill.slug);
  try {
    const res = await fetch(`${CDN}${skill.slug}.svg`);
    if (!res.ok) throw new Error(res.status);
    let svg = await res.text();
    svg = svg.replace(/\s*width="\d+"/, '').replace(/\s*height="\d+"/, '');
    if (!svg.includes('aria-hidden')) svg = svg.replace('<svg', '<svg aria-hidden="true"');
    _svgCache.set(skill.slug, svg);
    return svg;
  } catch {
    return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <text x="12" y="17" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11" font-weight="700">${skill.name.slice(0,3).toUpperCase()}</text>
    </svg>`;
  }
}

class ParticleSystem {
  constructor(canvas, color) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.particles = [];
    this.raf = null;
    this.active = false;
    this._iconShown = false;
  }

  _init() {
    const { width: W, height: H } = this.canvas;
    const cx = W / 2, cy = H / 2;
    this._iconShown = false;
    this.particles = Array.from({ length: PC }, () => {
      const side = Math.floor(Math.random() * 4);
      let x, y;
      if (side === 0)      { x = Math.random() * W; y = 0; }
      else if (side === 1) { x = W; y = Math.random() * H; }
      else if (side === 2) { x = Math.random() * W; y = H; }
      else                 { x = 0; y = Math.random() * H; }
      return {
        x, y,
        tx: cx + (Math.random() - 0.5) * 36,
        ty: cy + (Math.random() - 0.5) * 36,
        size: Math.random() * 2.4 + 0.7,
        alpha: 0,
        speed: Math.random() * 0.065 + 0.03,
        vx: 0, vy: 0,
      };
    });
  }

  _draw() {
    const { width: W, height: H } = this.canvas;
    this.ctx.clearRect(0, 0, W, H);
    this.ctx.shadowBlur = 10;
    this.ctx.shadowColor = this.color;
    this.ctx.fillStyle = this.color;
    for (const p of this.particles) {
      if (p.alpha <= 0.01) continue;
      this.ctx.globalAlpha = p.alpha;
      this.ctx.fillRect(Math.round(p.x - p.size / 2), Math.round(p.y - p.size / 2), p.size, p.size);
    }
    this.ctx.globalAlpha = 1;
    this.ctx.shadowBlur = 0;
  }

  entry(delay, onIconShow, onDone) {
    setTimeout(() => {
      this._init();
      this.active = true;
      const start = performance.now();

      const tick = (now) => {
        if (!this.active) return;
        const t = Math.min((now - start) / 950, 1);
        const ease = 1 - Math.pow(1 - t, 3);

        for (const p of this.particles) {
          p.x += (p.tx - p.x) * p.speed;
          p.y += (p.ty - p.y) * p.speed;
          if (t < 0.68) {
            p.alpha = Math.min(p.alpha + 0.055, ease * 0.88);
          } else {
            p.alpha = Math.max(0, p.alpha - 0.038);
          }
        }

        this._draw();

        if (t >= 0.62 && !this._iconShown) {
          this._iconShown = true;
          onIconShow?.();
        }

        const anyVisible = this.particles.some(p => p.alpha > 0.01);
        if (t < 1 || anyVisible) {
          this.raf = requestAnimationFrame(tick);
        } else {
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
          this.active = false;
          onDone?.();
        }
      };

      this.raf = requestAnimationFrame(tick);
    }, delay);
  }

  scatter() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.active = true;
    const { width: W, height: H } = this.canvas;
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.42;

    for (const p of this.particles) {
      p.x = cx + (Math.random() - 0.5) * 18;
      p.y = cy + (Math.random() - 0.5) * 18;
      const angle = Math.random() * Math.PI * 2;
      const spd = Math.random() * 3.5 + 1.5;
      p.vx = Math.cos(angle) * spd;
      p.vy = Math.sin(angle) * spd;
      p.alpha = 0.82;
    }

    const tick = () => {
      if (!this.active) return;
      this.ctx.clearRect(0, 0, W, H);
      this.ctx.shadowBlur = 10;
      this.ctx.shadowColor = this.color;
      this.ctx.fillStyle = this.color;

      for (const p of this.particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.955;
        p.vy *= 0.955;

        const dx = p.x - cx, dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxR) {
          const nx = dx / dist, ny = dy / dist;
          const dot = p.vx * nx + p.vy * ny;
          p.vx -= 2 * dot * nx * 0.55;
          p.vy -= 2 * dot * ny * 0.55;
          p.x = cx + nx * maxR;
          p.y = cy + ny * maxR;
        }

        if (p.alpha > 0.01) {
          this.ctx.globalAlpha = p.alpha;
          this.ctx.fillRect(Math.round(p.x - p.size / 2), Math.round(p.y - p.size / 2), p.size, p.size);
        }
      }

      this.ctx.globalAlpha = 1;
      this.ctx.shadowBlur = 0;
      this.raf = requestAnimationFrame(tick);
    };

    this.raf = requestAnimationFrame(tick);
  }

  reconverge(onDone) {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.active = true;
    const { width: W, height: H } = this.canvas;
    const cx = W / 2, cy = H / 2;

    for (const p of this.particles) {
      p.tx = cx + (Math.random() - 0.5) * 32;
      p.ty = cy + (Math.random() - 0.5) * 32;
      p.vx = 0; p.vy = 0;
      p.speed = Math.random() * 0.1 + 0.06;
    }

    const tick = () => {
      if (!this.active) return;
      this.ctx.clearRect(0, 0, W, H);
      this.ctx.shadowBlur = 10;
      this.ctx.shadowColor = this.color;
      this.ctx.fillStyle = this.color;

      let settled = true;
      for (const p of this.particles) {
        p.x += (p.tx - p.x) * p.speed;
        p.y += (p.ty - p.y) * p.speed;
        p.alpha = Math.max(0, p.alpha - 0.028);
        if (p.alpha > 0.01) {
          settled = false;
          this.ctx.globalAlpha = p.alpha;
          this.ctx.fillRect(Math.round(p.x - p.size / 2), Math.round(p.y - p.size / 2), p.size, p.size);
        }
      }

      this.ctx.globalAlpha = 1;
      this.ctx.shadowBlur = 0;

      if (!settled) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.ctx.clearRect(0, 0, W, H);
        this.active = false;
        onDone?.();
      }
    };

    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.active = false;
    if (this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

function buildCell(skill) {
  const wrap = document.createElement('article');
  wrap.className = 'skills-hex-wrap tier-' + (skill.tier || 'active');
  wrap.style.setProperty('--hc', skill.color);
  wrap.setAttribute('aria-label', skill.name);

  // Canvas dimensions are set by initSkillsHex once it knows the resolved hex width.
  const canvas = document.createElement('canvas');
  canvas.className = 'skills-hex-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  const hex = document.createElement('div');
  hex.className = 'skills-hex';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'skills-hex-icon-wrap';

  if (skill.imgPath) {
    // PNG icon — optionally strip white bg via canvas pixel pass, then display
    const img = document.createElement('img');
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    if (skill.imgFilter) img.style.filter = skill.imgFilter;
    if (skill.blendMode) img.style.mixBlendMode = skill.blendMode;
    if (skill.removeWhiteBg) {
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          const cx = cv.getContext('2d');
          cx.drawImage(img, 0, 0);
          const id = cx.getImageData(0, 0, cv.width, cv.height);
          const px = id.data;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > 235 && px[i+1] > 235 && px[i+2] > 235) px[i+3] = 0;
          }
          cx.putImageData(id, 0, 0);
          img.src = cv.toDataURL('image/png');
        } catch (_) {}
      };
    }
    img.src = skill.imgPath;
    iconWrap.appendChild(img);
  } else if (skill.inlineSvg) {
    // Multi-color inline SVG (transparent bg)
    iconWrap.innerHTML = INLINE_SVGS[skill.inlineSvg];
    const svg = iconWrap.querySelector('svg');
    if (svg) svg.style.cssText = 'width:100%;height:100%;display:block;';
  } else {
    // Simple Icons CDN — CSS color drives fill="currentColor"
    iconWrap.style.color = skill.iconColor || skill.color;
    fetchSvgIcon(skill).then(svgStr => {
      iconWrap.innerHTML = svgStr;
      const svg = iconWrap.querySelector('svg');
      if (svg) svg.style.cssText = 'width:100%;height:100%;display:block;';
    });
  }

  const label = document.createElement('span');
  label.className = 'skills-hex-label';
  label.textContent = skill.name;

  hex.append(iconWrap, label);
  wrap.append(canvas, hex);
  return { wrap, canvas, hex };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function initSkillsHex(root, { baseDelay = 0 } = {}) {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const grid = document.createElement('div');
  grid.className = 'skills-hex-grid';
  root.appendChild(grid);

  // Resolve hex dimensions from the CSS custom property defined on .skills-hex-grid /
  // its ancestors. parseFloat tolerates "124px" and the leading whitespace
  // getPropertyValue can return.
  const W = parseFloat(getComputedStyle(grid).getPropertyValue('--hex-w')) || 108;
  // Flat-top hex bbox: W is corner-to-corner width, H = W·√3/2 is flat-to-flat height.
  const H = W * Math.sqrt(3) / 2;
  const gridW = 2.5 * W;
  const gridH = 4 * H;

  // Connection SVG sits BEHIND every cell (z-index: 0). Cells are z-index: 1+.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'skills-hex-connections');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', `0 0 ${gridW} ${gridH}`);
  grid.appendChild(svg);

  const cells = [];
  for (const skill of SKILLS) {
    const pos = POSITIONS[skill.name];
    if (!pos) continue;
    const x = pos.tx * W;
    const y = pos.ty * H;

    const { wrap, canvas, hex } = buildCell(skill);
    wrap.style.left = x + 'px';
    wrap.style.top = y + 'px';

    // Match the canvas pixel buffer to the rendered hex size so particle
    // coordinates aren't squished by the clip-path's bounding box.
    canvas.width = Math.round(W);
    canvas.height = Math.round(H);

    const ps = reduceMotion ? null : new ParticleSystem(canvas, skill.color);

    if (!reduceMotion) {
      wrap.addEventListener('mouseenter', () => {
        if (!wrap.classList.contains('is-visible')) return;
        hex.classList.add('is-scattered');
        ps.scatter();
      });
      wrap.addEventListener('mouseleave', () => {
        if (!wrap.classList.contains('is-visible')) return;
        ps.reconverge(() => hex.classList.remove('is-scattered'));
      });
    }

    grid.appendChild(wrap);
    cells.push({
      skill,
      wrap,
      hex,
      ps,
      cx: x + W / 2,
      cy: y + H / 2,
    });
  }

  // Emit a <line> for every pair of cells whose centers are within ~1.05·H.
  // In a flat-top tiling, every neighbor sits at exactly distance H from its sibling;
  // non-neighbors (2 columns apart or 2 rows apart) are ≥ 1.5·W ≈ 1.73·H away.
  const lines = [];
  const adjThreshold = 1.05 * H;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (d > adjThreshold) continue;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', a.cx);
      line.setAttribute('y1', a.cy);
      line.setAttribute('x2', b.cx);
      line.setAttribute('y2', b.cy);
      line.style.strokeDasharray = d;
      line.style.strokeDashoffset = d;
      svg.appendChild(line);
      lines.push({ line, length: d });
    }
  }

  if (reduceMotion) {
    cells.forEach(c => c.wrap.classList.add('is-visible'));
    lines.forEach(({ line }) => { line.style.strokeDashoffset = '0'; });
    return;
  }

  let lastWaveDelay = 0;
  for (const cell of cells) {
    const waveDelay = WAVES[cell.skill.name] ?? 0;
    if (waveDelay > lastWaveDelay) lastWaveDelay = waveDelay;
    const fireAt = baseDelay + waveDelay;

    setTimeout(() => {
      cell.wrap.classList.add('is-revealing');
    }, fireAt);

    cell.ps.entry(
      fireAt,
      () => cell.hex.classList.add('is-appearing'),
      () => {
        cell.hex.classList.remove('is-appearing');
        cell.wrap.classList.remove('is-revealing');
        cell.wrap.classList.add('is-visible');
      }
    );
  }

  // Mesh draws in once the slowest cell's particle entry (~950ms) has settled.
  const meshStart = baseDelay + lastWaveDelay + 1000;
  lines.forEach(({ line }, idx) => {
    setTimeout(() => { line.style.strokeDashoffset = '0'; }, meshStart + idx * 50);
  });

  // Idle shuffle: two random cells swap positions every ~4s via scatter → warp → reconverge.
  function startShuffleLoop() {
    function loop() {
      const available = cells.filter(
        c => c.wrap.classList.contains('is-visible') && !c.shuffling
      );
      if (available.length >= 2) {
        const idxA = Math.floor(Math.random() * available.length);
        let idxB;
        do { idxB = Math.floor(Math.random() * available.length); } while (idxB === idxA);
        const a = available[idxA], b = available[idxB];
        a.shuffling = b.shuffling = true;

        a.ps.scatter();
        b.ps.scatter();

        setTimeout(() => {
          const [al, at] = [a.wrap.style.left, a.wrap.style.top];
          a.wrap.style.left = b.wrap.style.left;
          a.wrap.style.top  = b.wrap.style.top;
          b.wrap.style.left = al;
          b.wrap.style.top  = at;
          [a.cx, b.cx] = [b.cx, a.cx];
          [a.cy, b.cy] = [b.cy, a.cy];
          svg.style.opacity = '0';
        }, 80);

        setTimeout(() => {
          svg.style.opacity = '1';
          a.ps.reconverge(() => { a.shuffling = false; });
          b.ps.reconverge(() => { b.shuffling = false; });
        }, 600);
      }
      setTimeout(loop, 4000);
    }
    loop();
  }

  setTimeout(startShuffleLoop, baseDelay + 2500);
}
