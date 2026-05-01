# Spec: Terminal Command Interface

## Overview

Build the most differentiating element on the page — a real
terminal prompt that visitors can type into to navigate the
site. Commands like `whoami`, `skills`, `projects`, `resume`,
and `contact` route to the right section. Tab-complete works.
Up-arrow recalls history. The blinking caret and prompt sigil
match the AI-terminal aesthetic. This signals "I work with
agents" louder than any bullet point ever could.

## Depends on

- Spec 01 (`#terminal` anchor).
- Spec 02 (hero hint already points at it).

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — populate `#terminal` with the
  prompt UI (history pane + input row).

## Files to change

- `index.html` — terminal markup inside `#terminal`.
- `assets/css/components.css` — `.terminal`, `.terminal-line`,
  `.terminal-prompt`, `.terminal-input`, `.caret` styles.
- `assets/js/main.js` — lazy-init terminal when `#terminal`
  enters viewport; fetch `commands.json`.
- `assets/js/terminal.js` — implement `initTerminal(root, registry)`
  with command parsing, history, tab-complete, and dispatching.

## Files to create

None.

## New dependencies

None. Vanilla JS.

## Rules for implementation

- Commands defined in `assets/js/data/commands.json`. Don't
  hardcode command names in JS. Each entry has `name`,
  `description`, `action`, optional `target`, `hidden`.
- Supported actions: `scroll` (to a CSS selector), `download`
  (links to a file), `clear`, `help`, `easteregg`. Dispatch
  table in `terminal.js`; new actions added by extension, not
  by editing the parser.
- Tab cycles through commands matching the current prefix.
  Up/Down arrows walk the history (max 50 entries).
- On `Enter`, echo the typed line as a `.terminal-line`, run
  the command, then write any output as additional lines.
- Unknown command prints `command not found: <name>. type 'help'`
  and continues.
- The terminal must be focusable (visible caret + outline) and
  pass keyboard accessibility — `aria-label="Site terminal"`,
  Tab key reaches it, Escape blurs it.
- Hidden commands (`sudo hire-me`) don't show in `help` or
  tab-complete, but they execute when typed exactly.
- Easter-egg action triggers a brief shader flare (bumps a
  uniform in `shader.js`); coordinated via a custom DOM event
  `portfolio:flare` so terminal doesn't import shader.

## Definition of done

- [ ] `#terminal` shows a prompt row with `>` sigil and a
      blinking caret.
- [ ] Typing `help` lists all visible commands with their
      descriptions.
- [ ] Typing `whoami`, `skills`, `projects`, `experience`,
      `contact` smooth-scrolls to the respective section.
- [ ] Typing `resume` triggers a download of
      `assets/img/resume.pdf`.
- [ ] Typing `clear` empties the history pane.
- [ ] Tab on partial input cycles through matching commands.
- [ ] Up/Down arrows recall typed history.
- [ ] Unknown command shows the not-found message.
- [ ] `sudo hire-me` triggers the easter-egg shader flare.
- [ ] Terminal is keyboard-accessible (Tab focus, Escape blur).
- [ ] Mobile (touch): a single tap focuses the input and
      brings up the on-screen keyboard.
- [ ] No commands are hardcoded in JS — all live in
      `commands.json`.
