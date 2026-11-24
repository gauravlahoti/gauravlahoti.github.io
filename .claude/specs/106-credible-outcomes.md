# Spec: Credible Outcomes

## Overview
The Selected Work headlines read ~500x, ~68x and ~2x. Two of them compared different things: the AI's model cost against the fully loaded cost of a human contact or of a whole AP process. The third was never measured. An enterprise reader catches that quickly and starts doubting the real numbers too. This spec keeps the % / x format, because recruiters read it fastest, but every headline now compares like with like and rounds down.

## Depends on
- Spec 100 (Selected Work cards and the efficiency box template).

## Routes
No backend.

## Database changes
No database.

## Templates
- **Create:** this spec
- **Modify:** `content/selected-work.json`

## Files to change
- `content/selected-work.json`
  - **Conversational AI:** `~10x faster first response`. An answer in under 3 s vs about 35 s for a live agent's first chat reply (LiveChat). The true ratio is ~12x.
  - **Document workflow:** `~70% lower cost per invoice`. Ardent Partners puts the average at $9.40 and best-in-class at $2.78, about 70% lower. The $0.14 model cost plus human review of exceptions lands in that range. The problem text now cites the $2.78 too.
  - **Multi-agent errors:** `~80% faster fixes on repeat errors`. Digging takes 30 to 90 min. A known fix comes back in seconds, plus about 5 to 10 min to check it. This covers repeat errors only.
  - **Tiles:** no "vs" ratios against model cost. "~1 day/wk back per employee" and "$0 research" were dropped as overclaims.

## Rule for future cards
The headline compares like with like: response time with response time, total cost with total cost. Never compare a model cost against a fully loaded human cost. Round in the conservative direction, and scope the claim ("on repeat errors") when it doesn't hold in general.

## New dependencies
No new dependencies.

## Rules for implementation
- All identity content lives in `content/profile.json`.
- CSS variables only. Never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`.
- Mobile fallbacks for every WebGL/Three.js feature.

## Definition of done
- [ ] `/selected-work/` and the home `#work` teaser show ~10x, ~70% and ~80%, and each counts up to its value
- [ ] No tile wraps badly at desktop or 375px width
- [ ] `content/selected-work.json` parses and has no em-dashes
