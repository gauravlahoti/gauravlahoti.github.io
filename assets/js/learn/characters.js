// learn/characters.js — original inline-SVG avatars + pose helpers.
// Art is original/stylised (no copyrighted sprites). Colour comes from the
// wrapper's `--char-accent` custom property via `currentColor`/var() so each
// character retints cleanly. viewBox is 0 0 120 140.

// Sparkfist — spiky-haired energy warrior (Dragon-Ball-inspired silhouette).
function sparkfistSvg() {
    return `
<svg viewBox="0 0 120 140" class="learn-avatar-svg" role="img" aria-label="Sparkfist">
  <title>Sparkfist</title>
  <!-- energy aura -->
  <ellipse class="learn-avatar-aura" cx="60" cy="74" rx="46" ry="56"/>
  <!-- spiky hair -->
  <path class="learn-avatar-accent" d="M60 6 L70 30 L82 16 L82 38 L98 32 L88 50 L106 52 L88 62 L60 50 L32 62 L14 52 L32 50 L22 32 L38 38 L38 16 L50 30 Z"/>
  <!-- head -->
  <circle class="learn-avatar-skin" cx="60" cy="56" r="20"/>
  <!-- eyes -->
  <circle class="learn-avatar-eye" cx="52" cy="55" r="2.6"/>
  <circle class="learn-avatar-eye" cx="68" cy="55" r="2.6"/>
  <!-- determined mouth -->
  <path class="learn-avatar-line" d="M53 66 Q60 70 67 66"/>
  <!-- body / gi -->
  <path class="learn-avatar-body" d="M44 78 Q60 72 76 78 L82 116 Q60 124 38 116 Z"/>
  <!-- belt -->
  <rect class="learn-avatar-accent" x="42" y="100" width="36" height="7" rx="2"/>
  <!-- raised fist with spark -->
  <circle class="learn-avatar-skin" cx="92" cy="80" r="8"/>
  <path class="learn-avatar-spark" d="M92 64 L95 74 L104 72 L97 80 L104 88 L94 84 L92 96 L90 84 L80 88 L87 80 L80 72 L89 74 Z"/>
</svg>`;
}

// Hopper — round, red-capped jumper (platformer-inspired silhouette).
function hopperSvg() {
    return `
<svg viewBox="0 0 120 140" class="learn-avatar-svg" role="img" aria-label="Hopper">
  <title>Hopper</title>
  <ellipse class="learn-avatar-aura" cx="60" cy="78" rx="42" ry="54"/>
  <!-- cap -->
  <path class="learn-avatar-accent" d="M36 44 Q60 22 84 44 L84 48 L36 48 Z"/>
  <!-- cap brim -->
  <path class="learn-avatar-accent" d="M30 48 Q44 40 72 48 L72 54 Q50 50 30 56 Z"/>
  <!-- cap emblem -->
  <circle class="learn-avatar-emblem" cx="60" cy="38" r="6"/>
  <!-- face -->
  <circle class="learn-avatar-skin" cx="60" cy="62" r="18"/>
  <!-- eyes -->
  <circle class="learn-avatar-eye" cx="53" cy="60" r="2.4"/>
  <circle class="learn-avatar-eye" cx="67" cy="60" r="2.4"/>
  <!-- moustache / smile -->
  <path class="learn-avatar-line" d="M51 70 Q60 78 69 70"/>
  <!-- round body -->
  <path class="learn-avatar-body" d="M42 80 Q60 74 78 80 Q86 100 78 118 Q60 126 42 118 Q34 100 42 80 Z"/>
  <!-- overalls buttons -->
  <circle class="learn-avatar-emblem" cx="51" cy="98" r="3"/>
  <circle class="learn-avatar-emblem" cx="69" cy="98" r="3"/>
</svg>`;
}

const BUILDERS = { sparkfist: sparkfistSvg, hopper: hopperSvg };

// Return the SVG markup string for a character id.
export function characterSvg(id) {
    return (BUILDERS[id] || sparkfistSvg)();
}

// Toggle a pose class on the avatar wrapper. pose: "idle" | "cheer" | "hurt".
// GSAP transforms are layered on top by the caller; this drives CSS state.
export function setPose(wrapEl, pose) {
    if (!wrapEl) return;
    wrapEl.classList.remove("is-idle", "is-cheer", "is-hurt");
    wrapEl.classList.add(`is-${pose}`);
}
