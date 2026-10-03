# Spec 87: The custom cursor shows on touchscreen laptops

The cyan bracket cursor (spec 08) showed on a Mac but never on a Windows touchscreen laptop, though that laptop has a trackpad.

## Cause

Three gates, all keyed on the wrong question:
- `main.js` `initCursorAsync()` bailed on `(any-pointer: coarse)`. That's true on **any** device with a touchscreen, laptops included.
- `cursor.js` `initCursor()` required `(hover: hover)`, which describes only the *primary* pointer. Chrome on Windows can report a touch laptop's primary pointer as touch.
- `components.css` force-hid `.cursor` under `(any-pointer: coarse)`.

## Fix

- All three gates now ask "is there any pointer that can hover precisely?": `(any-pointer: fine) and (any-hover: hover)`. A trackpad or mouse gets the cursor; a touch-only phone or tablet doesn't. The CSS guard is `not all and (any-pointer: fine), (any-hover: none)`, plus reduced motion as before.
- On a touch laptop a finger tap also fires mouse events, which would park the brackets wherever the finger landed. `cursor.js` listens for `pointerdown`/`pointermove` and sets `.is-touch` (opacity 0) while the pointer is a finger, then clears it on the next trackpad or mouse move.

## Definition of done

- [x] Desktop (fine pointer, no touch): the cursor exists and shows.
- [x] Touch-only emulation (DevTools touch, which drops every fine pointer): no cursor, as on a phone.
- [x] A touch `pointerdown` hides the brackets; the next mouse `pointermove` brings them back.
- [ ] A real Windows touchscreen laptop: the brackets follow the trackpad and hide while the screen is touched. (DevTools can't emulate a touchscreen and a trackpad at the same time.)
