---
name: CSS Conventions and Known Violations
description: CSS variable usage rules and where hardcoded rgba values legitimately exist vs are new violations
type: project
---

All colours, spacing, and type scale must use CSS custom properties defined in `assets/css/base.css`. Hardcoded hex or rgb values are forbidden in new code.

**Known pre-existing rgba in older code (not violations to flag):** Older sections of `components.css` and `layout.css` use hardcoded `rgba()` for box-shadows, borders, and gradient overlays. These pre-date the strict token convention.

**New violation found in spec 22 (commit e69028b):**
- `assets/css/components.css` bottom-bar gradient (lines ~2061-2062) uses `rgba(8, 10, 18, 0.85)` and `rgba(8, 10, 18, 0.95)`. These are hardcoded background color values. The token `--bg` is `#000000` and `--bg-elev` is `#0A0A0A`. Neither has an RGB-component token for use in rgba(). This should be `color-mix()` or a new `--bg-rgb` token to allow opacity variants.

**Key tokens in base.css:**
- `--bg: #000000`, `--bg-elev: #0A0A0A`, `--bg-card: #111111`
- `--accent: #00FFD1`, `--accent-soft: rgba(0,255,209,0.12)`, `--accent-glow: rgba(0,255,209,0.35)`
- `--border: rgba(255,255,255,0.08)`, `--border-strong: rgba(255,255,255,0.16)`
- Spacing: `--space-1` through `--space-24`; `--space-12: 3rem` (not 4rem as the spec comment claimed)
- `--radius-xl` does NOT exist; `--radius-lg: 16px` is the largest defined radius token
