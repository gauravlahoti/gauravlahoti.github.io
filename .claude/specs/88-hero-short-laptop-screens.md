# Spec 88: The hero fits short laptop screens

On a Mac the hero looked right. On colleagues' Windows laptops at 100% browser zoom, the "Atlas has responded to N questions" line ran under the cert badge rail, the badges sat cut off at the bottom, and "scroll to explore" was off-screen. Zooming the browser out to 80% fixed it.

## Cause

Windows laptops usually run at 125% or 150% display scaling. A 1920x1080 panel at 150% gives the browser about 1280x600 of CSS space once the tabs and address bar are taken; at 125%, about 1536x730. A 1366x768 laptop at 100% gives about 1366x657. Browser zoom at 80% cancels the 125% scaling, which is why it "fixed" it.

Every hero rule keys on width only:
- The cert rail is absolute at the bottom of the hero and takes about 192px (144px tall, 48px off the bottom).
- In the 901-1439px band the stack reserved `clamp(160px, 24vh, 260px)` beneath itself. On a 600px-tall screen that's 160px, so the last ~30px of text ran under the rail.
- With the hero's `min-height: 100svh`, the content pushed the hero past the screen height, taking "scroll to explore" off the bottom.

## Fix

One height-aware block at the end of `components.css`, `@media (min-width: 901px) and (max-height: 800px)`, so tall screens (every Mac, 1080p at 100%) are untouched:
- The rail is a little shorter (104px, 80px tiles) through a single `--cert-rail-h`, and the stack's `padding-bottom` reserves exactly the rail, its offset and a gap, so they can't drift apart.
- The top padding stays clear of the "// open to architecture engagements" line.
- The name, identity line and tagline scale with `min(vw, vh)`, so a short screen gets slightly smaller type instead of an overflow.

The 901-1439px band still swaps the portrait for the hex panel; that was a deliberate earlier fix for this width range and is unchanged.

## Definition of done

- [x] At 1280x600 the hero is exactly the screen height; the label, name, text, rail and "scroll to explore" don't overlap (text ends 18px above the rail).
- [x] An iframe sweep with automatic overlap checks passes at 1280x600, 1280x650, 1366x657, 1536x730, 1440x780, 1600x760, 1024x600, 920x620, 1512x860 and 1920x950. The last two are outside the new rule and unchanged.
- [x] Hex panel labels ("LangChain", "LangGraph") are not clipped.
- [ ] Checked on a real Windows laptop at 100% browser zoom.
