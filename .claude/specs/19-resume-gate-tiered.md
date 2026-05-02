# Spec: Resume gate — tiered access (ungated 1-page summary + gated full resume)

## Overview
Today the resume modal (defined at `index.html:319-337`, controlled by `assets/js/resume-gate.js`) gates the resume PDF behind Google Sign-In. The flow is solid for capturing serious leads but adds friction for the exact recruiter / CTO persona the portfolio targets — many of them just want to skim a one-pager and decide whether to go further. This spec implements **Option B** from the feedback: a **two-track resume modal** with both an ungated 1-page summary and the existing gated full resume. Recruiters and skim-readers get the 1-page summary directly. High-intent visitors who want the full resume go through the existing Google Sign-In flow, and the lead capture stays intact for that path.

The modal becomes a fork: two side-by-side primary actions, "Quick view (1-page)" and "Full resume (sign-in)". The Quick view button triggers a direct download of `assets/img/gaurav-lahoti-summary.pdf` — no auth, no Worker call, no lead row written. The Full resume button reveals the existing Google Sign-In button (or auto-completes if the 30-day localStorage bypass is still valid, matching today's behaviour). All existing resume-gate machinery — GIS button render, JWT POST to the Worker, lead row insertion in D1, error handling, 30-day cache — is preserved untouched for the Full resume path.

The mental model: **recruiters get out of the modal in one click; serious leads sign in.** Both paths exist in parallel.

## Depends on
- Spec 11 (resume-gate) — modal markup, dialog + form structure
- Spec 12 (resume-gate-google-auth) — Google Identity Services flow, Worker JWT verification, lead row insertion, 30-day localStorage cache

## Routes
No new routes. The existing `POST /api/resume-download` endpoint (Cloudflare Worker / `backend/src/index.js:29-48`) is unchanged. The Quick view path **does not** call the Worker.

## Database changes
None. The Quick view path does not write a lead row. The Full resume path continues to write to the existing leads table from spec 11.

## Templates
- **Create:**
  - `assets/img/gaurav-lahoti-summary.pdf` — new 1-page summary PDF (you provide). Should be a tight one-page distillation of the longer resume: name, title, top 3 capabilities, top 2 outcomes, contact, link to full resume gate. The actual content is your call; the spec only requires the file exist at this path.
- **Modify:**
  - `assets/js/data/profile.json` — add a new field under `links`:
    ```json
    "resumeSummary": "assets/img/gaurav-lahoti-summary.pdf"
    ```
    Adjacent to the existing `resume` and `resumeApi` keys. The new field is the path to the ungated 1-pager.
  - `index.html:319-337` — update the modal structure to support two actions. The new shape:
    ```html
    <dialog class="resume-modal" data-resume-modal aria-labelledby="resume-modal-title">
      <div class="resume-form" data-resume-form>
        <header class="resume-form-head">
          <p class="resume-form-eyebrow">// resume::request</p>
          <h3 id="resume-modal-title">Resume</h3>
          <p class="resume-form-sub">A one-page snapshot, or the full thing after a quick sign-in.</p>
        </header>

        <div class="resume-form-tracks">
          <!-- Quick view (ungated) -->
          <div class="resume-form-track resume-form-track-quick">
            <h4 class="resume-form-track-title">Quick view</h4>
            <p class="resume-form-track-sub">1-page summary. No sign-in.</p>
            <a class="btn btn-primary"
               data-resume-quick
               href="assets/img/gaurav-lahoti-summary.pdf"
               download="gaurav-lahoti-summary.pdf"
               target="_blank"
               rel="noopener">Download 1-page</a>
          </div>

          <!-- Full resume (gated) -->
          <div class="resume-form-track resume-form-track-full">
            <h4 class="resume-form-track-title">Full resume</h4>
            <p class="resume-form-track-sub">Verified by Google. I won't share your details.</p>
            <div id="g-signin-btn" data-gsi-button></div>
            <p class="resume-loading-row" data-resume-loading-row hidden>
              <span class="resume-loading"></span>
              <span data-resume-loading-label></span>
            </p>
            <p class="resume-error" data-resume-error hidden></p>
          </div>
        </div>

        <div class="resume-form-actions">
          <button type="button" class="btn btn-ghost" data-resume-cancel>Close</button>
        </div>
      </div>
    </dialog>
    ```
    The `data-resume-trigger` link in the nav (`index.html:110`) is unchanged.
  - `assets/js/resume-gate.js` — extend `initResumeGate(profile)`:
    - Read `profile.links.resumeSummary` and use it as the `href` for the Quick view anchor (replacing the hardcoded path in the markup if you prefer the data-binding approach — both are acceptable; pick one).
    - Wire a click listener on `[data-resume-quick]` that **fires telemetry only** (a `console.info` placeholder is acceptable in v1; no Worker call). The native anchor download attribute does the actual file fetch.
    - Preserve the entire existing GIS render flow on `[data-gsi-button]`: `window.google.accounts.id.renderButton()`, JWT capture, POST to `profile.links.resumeApi`, error display, loading row toggle, 30-day localStorage bypass.
    - **Important:** the Quick view path must not invalidate or overwrite the 30-day cache. A user who clicks Quick view today and Full resume next month should still get the cached bypass on the Full resume side.
  - `assets/css/components.css` — append rules:
    - `.resume-form-tracks` — flex / grid layout for the two columns. Desktop: side-by-side, `gap: var(--space-6)`. Mobile (`(max-width: 768px)`): single column, stacked.
    - `.resume-form-track` — bordered card surface (`border: 1px solid var(--border)`, `border-radius: var(--radius-md)`, `padding: var(--space-4)`).
    - `.resume-form-track-title`, `.resume-form-track-sub` — typography matching the existing `.resume-form-eyebrow`/`.resume-form-sub` pair scaled down one step.
    - Subtle visual differentiation between Quick (lighter weight, no glow) and Full (slight accent border or soft glow on hover) so the user understands which is the "premium" path. Don't overdo it — both should feel respectful and friction-aware.

## Files to change
- `assets/js/data/profile.json`
- `index.html`
- `assets/js/resume-gate.js`
- `assets/css/components.css`

## Files to create
- `assets/img/gaurav-lahoti-summary.pdf`

## New dependencies
None.

## Rules for implementation
- CSS variables only — never hardcode hex. Reuse `--bg-card`, `--bg-elev`, `--border`, `--border-strong`, `--accent`, `--ink`, `--ink-muted`, `--ink-subtle`, `--space-*`, `--radius-md`, `--text-*`, `--font-sans`, `--font-mono`.
- The Quick view path **never** calls the Worker. Confirmed via DevTools Network panel during DoD verification.
- The Quick view path **never** writes a lead row. There is no privacy footnote or sign-in prompt on this path.
- The Full resume path is byte-equivalent to today's flow: GIS button render, credential capture, JWT POST, error display, loading row, 30-day localStorage cache. No regressions to spec 11/12 behaviour.
- The 30-day localStorage cache key (set when Full resume succeeds) is **not** read by the Quick view path. They are independent code paths.
- The Quick view anchor uses the native `download` attribute. `target="_blank"` is added so a user clicking on iOS Safari (which ignores `download` on cross-document anchors) gets a viewable PDF in a new tab as a fallback. `rel="noopener"` for safety even on same-origin (the file is local).
- The modal `<dialog>` element's `inert` / focus management behaviour is preserved. The first focusable element on open is the Quick view button (it's the lower-friction primary action). Tab order: Quick view button → GSI button → Close. Esc closes.
- Mobile: at `(max-width: 768px)` the two tracks stack vertically with Quick view above Full resume. The full GSI button width must not be cropped on a 360px viewport.
- Don't add a "Most popular" or "Recommended" badge. Both paths are valid; both should look respectable.
- All text rendered via `textContent` (where applicable) or static markup. No `innerHTML`.

## Definition of done
Verifiable in a browser at `http://localhost:5173`.

### Quick view path
1. **Quick view button visible.** Opening the resume modal shows two clearly labelled tracks: "Quick view" (1-page) and "Full resume" (sign-in).
2. **Direct download.** Clicking "Download 1-page" downloads `gaurav-lahoti-summary.pdf` immediately. No Google prompt. No spinner on the modal.
3. **No Worker call.** DevTools Network panel during the Quick view click shows only the static PDF fetch — no request to `*.workers.dev/api/resume-download`.
4. **No lead row written.** Verified by querying the leads D1 table after a Quick view click — no new row.
5. **iOS Safari fallback.** On iOS Safari (or simulating with the `download` attribute disabled), clicking Quick view opens the PDF in a new tab. The user can save from the browser's native viewer.

### Full resume path (regression)
6. **GSI button renders.** The `[data-gsi-button]` slot still hosts the rendered Google Identity Services button on modal open. (No regression vs spec 12.)
7. **Sign-in completes the flow.** Signing in posts the JWT to `profile.links.resumeApi`, the Worker verifies and inserts a lead row, the full resume PDF download fires.
8. **30-day cache.** A user who completed Full resume sign-in within the past 30 days and reopens the modal: the GSI button auto-completes via the cached bypass, the full resume downloads without re-authenticating. (No regression.)
9. **Error display.** If the Worker returns a non-2xx, the `[data-resume-error]` slot displays a human-readable message; the Quick view path remains unaffected and clickable.

### Modal & navigation
10. **Trigger unchanged.** The "Resume" link in the nav (`index.html:110`) opens the modal as before. The link's hover/cursor magnet treatment is unchanged.
11. **Tab order.** Tab cycles: Quick view button → GSI button → Close. Shift+Tab reverses. Focus is trapped in the dialog while open.
12. **Esc closes.** Pressing Esc from any state closes the dialog and restores focus to the trigger link.
13. **First focus.** On open, focus lands on the Quick view button (the lower-friction primary action).

### Layout
14. **Desktop side-by-side.** At ≥ 768px the two tracks render side-by-side with equal width and a clear gutter. Both card surfaces are visually balanced.
15. **Mobile stack.** At 360 / 390 / 768 viewports the tracks stack vertically with Quick view on top. GSI button is not cropped at 360px width.
16. **Visual differentiation.** Quick view and Full resume look distinct enough that the user understands they are two paths, but neither is dismissed or sub-billed (no "free trial" energy on Quick view, no "premium" gating language on Full resume).

### Cross-cutting
17. **Independence.** Editing `profile.links.resumeSummary` to a different file path swaps the Quick view download with no other code change. The Full resume flow continues to use `profile.links.resume` and `profile.links.resumeApi` independently.
18. **Lighthouse Accessibility ≥ 95** with the new modal layout. axe DevTools reports zero new violations.
19. **Lighthouse Performance ≥ 90** unchanged.
20. **No console errors** during a full Quick-view-then-Full-resume flow on a fresh session, and on a session with the 30-day cache active.
