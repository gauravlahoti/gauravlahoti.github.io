# Spec 89: The agent index becomes a capability matrix

The agent index on `/live-agents/` had outgrown itself. Four agents generated 25 filter chips across TYPE / MODEL / PATTERN, and most chips matched exactly one agent. The vocabulary had drifted too: "RAG" was both a type and a pattern, "Tool Use" and "Tool-use" were separate chips, STT / TTS / Voice overlapped, and each MODEL chip was one agent's raw model string. "Chat" no longer described Atlas, which now talks by text, voice and a live video avatar. Pulse was still listed on Gemini 3.5 Flash, though it runs `gemini-3.8-flash`.

## What replaced it

A capability matrix inside the existing console frame: **one row per agent, one column per capability, then the model.** An earlier cut had capabilities as rows; at 8 rows it was about twice the old chips' height, so it was flipped. The grid is now about 205px tall at desktop, and the first cards sit above the fold.

- **Columns, in three named groups**, so a visitor knows what kind of thing each one is. A first cut had 8 flat columns (Text, Voice, Avatar, Autonomous, Multi-agent, Cites, Acts, Learns) that mixed four different axes, and three of the labels were invented words.
  - **Talk to it:** Chat, Voice, Avatar (the modalities).
  - **How it runs:** On demand, Ambient, Multi-agent. Every agent is exactly one of On demand or Ambient (the field's term for an agent that works in the background, and what Pulse's card already calls it), so the group accounts for all of them. A first cut had only Background and left Atlas's row empty.
  - **Built with:** Retrieval, Tools, Memory. These are Anthropic's "augmented LLM" building blocks, the standard vocabulary.
  - Keys in `agents.json` stayed stable (`text, voice, avatar, autonomous, team, cites, acts, learns`). Labels, groups and one-sentence hints live in `CAPABILITIES` / `CAPABILITY_GROUPS` in `agents-page.js`.
- **Every lit dot explains itself.** Hover, focus or tap shows one plain sentence of evidence in a readout strip under the grid (for example "ErrorLens · Tools: writes confirmed fixes to AlloyDB and queries it through the MCP Toolbox for Databases"), from `agents.json` → `index.evidence`. Lit dots are focusable, and their visually-hidden text carries the same sentence. Hovering a column header shows its definition.
- **Models** show the official Gemini and Claude marks (`assets/img/logo-*.svg`, the same files the chat widget and labs use), in brighter text. A two-model string ("Gemini 3.6 Flash · 3.8 Live") reads as two lines.
- **A column header filters** the cards to the agents that have it. Pressing it again clears it. Non-matching agent rows dim, and the locked column lights as a beam.
- **An agent's name jumps** to its card, which pings. A filter hiding that card is cleared first.
- **Search stays**, with the "/" shortcut on desktop, clear and an "N of 4" readout. It now matches capability labels and the model.
- Table semantics (`role="table"`, row and column headers, a visually-hidden yes/no per cell) over one CSS grid; row wrappers are `display: contents`.

## Look and feel

- **Power-on, once, on first view:** a scanline sweeps down, rows slide in, each lit node boots (scale plus a ring flash), traces draw, and the column labels type in.
- Atlas's Text / Voice / Avatar nodes use the spec 67 mode colours (cyan, violet, magenta-amber), so its range reads as a spectrum. Every other node is accent cyan.
- Faint column rails make the grid read like a circuit. A light trace runs down each shared capability's column (Cites, Acts) with a slow idle data pulse that speeds up on hover or lock. Lit nodes breathe, staggered.
- Each agent has a status LED (pulsing when LIVE) and its role under its name. Models sit in a dashed-off readout column.
- Animations use transform and opacity only, and the scanline runs once (the continuous console scan stays removed, a past performance fix). `prefers-reduced-motion` gets the final state with no animation.
- **Phones (≤600px):** nine columns don't fit, so a segmented switch (Talk to it / How it runs / Built with / Model) shows one group at a time as a 4 × 3 grid with horizontal labels. Each group has three columns. Cells carry a desktop column (`--gc`) and a phone column (`--gcm`) as CSS variables, so the phone layout re-places them. An earlier cut squeezed all nine columns in with vertical labels, and it was cramped. The readout prompt says "tap" on touch screens, and the "/" hint is hidden.

## Dates

One stamp per agent under its model and on its card: "updated Oct 2026" after a meaningful update, otherwise "shipped May 2026" (`index.shipped` / `index.updated`, YYYY-MM, from git history). It dates the model choice, so ErrorLens on Gemini 2.5 reads as the newest model when it shipped rather than a stale one. Upgrading ErrorLens itself is separate work in its own repo.

## Data

`agents.json`: `searchMeta {type, model, patterns}` → `index {capabilities, model, evidence}`. Nothing else read `searchMeta`. Pulse → Gemini 3.8 Flash (stack, traits, step 2). ErrorLens stays on Gemini 2.5 (confirmed). Agentic RAG shows Claude Sonnet 4.6, its default. Atlas reads `content/*.json` live, so no redeploy is needed.

## Definition of done

- [x] `node --test 'tests/**/*.test.mjs'` (19) passes; `agents.json` parses.
- [x] Groups: Talk to it (Chat, Voice, Avatar), How it runs (On demand, Ambient, Multi-agent), Built with (Retrieval, Tools, Memory).
- [x] Hovering ErrorLens × Tools shows its AlloyDB/MCP sentence; tapping a dot on a phone does the same.
- [x] Gemini marks next to Atlas, Pulse and ErrorLens, and the Claude mark next to Agentic RAG.
- [x] The matrix matches the truth table: Atlas text/voice/avatar/cites/acts; Pulse autonomous/acts; ErrorLens multi-agent/cites/acts/learns (it writes confirmed fixes to AlloyDB and calls MCP tools and online sources); Agentic RAG cites.
- [x] Retrieval → Atlas, ErrorLens, Agentic RAG (3 of 4), with Pulse dimmed. Tools → Atlas, Pulse, ErrorLens. Avatar → Atlas only. Pressing again restores all 4.
- [x] Search "claude" → Agentic RAG. Clear resets everything.
- [x] The ErrorLens name scrolls to and pings its card.
- [x] 390px: no horizontal scroll, no clipped labels. 1280×600: reads well.
- [x] Phones: four tabs switch the grid; Built with shows Retrieval/Tools/Memory with traces; tapping a dot fills the readout; no horizontal scroll.
- [x] Dates: Atlas and Pulse "updated Oct 2026", ErrorLens "shipped May 2026", Agentic RAG "shipped Jun 2026", in the model column and on the cards.
- [ ] Reviewed by Gaurav locally before shipping.
