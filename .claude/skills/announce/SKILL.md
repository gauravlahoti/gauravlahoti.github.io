---
name: announce
description: Put a LinkedIn post (new or old) or an AI Lab on the site's top announcement bar. Takes a LinkedIn URL, a lab name, or "pick from my posts", drafts the one-line banner text and link, confirms with you, and writes content/announcement.json for 7 days. Examples - "/announce https://www.linkedin.com/posts/...", "/announce MCP lab", "/announce my RAG post", "/announce engineering loops 14 days".
---

# announce

Set the top-of-page announcement bar. The bar reads `content/announcement.json`,
shows for `durationDays` from `startsOn`, then disappears on its own. The whole
sentence and the cyan CTA pill both link to `href`. This skill edits that JSON file
and keeps `assets/js/announce-hint.js` in step with it (see Step 4). It never deploys.

Input: a LinkedIn post URL, a lab name or id, or words that point at a post already
in `content/posts.json` (old posts are fine). Optional `N days` sets the duration
(default 7).

## Step 1: Resolve what to announce

- **LinkedIn URL** (`https://www.linkedin.com/posts/...` or `/feed/update/...`):
  1. Run `node scripts/add-post.mjs <url> --print`. Exit 0 gives the entry as JSON,
     use its `firstLine` and `excerpt`.
  2. Exit 3 means it is already in `posts.json`. That is fine here. Read the entry
     from `content/posts.json` by matching `url`.
  3. Exit 4 means LinkedIn blocked the fetch. Ask the user for the post's first line.
  Do NOT add the post to `posts.json` from this skill. That is `/add-post`.
  Mention it if the post is not in Perspectives yet.
- **Lab** (by name or id): read `content/ai-concepts.json`, match on `id`, `title`
  or `tagline`. Use its `href` (an internal path like `/ai-labs/mcp-lab/` works as is)
  and its `title`, `tagline`, `description` for the copy. Check `status` is `LIVE`.
- **An existing post by description**: search `content/posts.json` `firstLine` and
  `excerpt`. If more than one matches, show the top 3 and ask which.

If nothing matches, say so and stop. Do not invent a link.

## Step 2: Draft the banner copy

- `text`: one plain sentence, 80 characters or fewer. This is what laptops show,
  on one line.
- `mobileText`: what phones show instead, **24 characters or fewer**. Always write
  one. The phone text column is only about 270px wide, and visitors who raise
  their text size (Android's font size setting) get 115% to 150% type. The full
  `text` fits in two lines only at the default size and is cut off past that
  (this happened, the tail "Watch it work." was lost on a real phone). The
  phone bar is one slim line (44px), text centred on the screen with the arrow
  and close button on the right, so the column is only about 230px. 24
  characters stays on one line up to 130% text size on a 390px phone (a narrower
  phone wraps to two lines sooner, which is still fine). It is the same message, not a
  fragment: "Watch the harness work." not "Harness tour". Say what it is, not that it is "new". The user may be
  promoting an old post, so never add "New post:" or "Just launched" unless the
  user said it is new.
- `cta`: two or three words. `Read the post` for a post, `Open the lab` for a lab.
- Voice rules from CLAUDE.md: no em-dashes, short natural sentences, no stock LLM
  phrasing. Read it back out loud.
- Derive `text` from the post's first line or the lab's tagline. Trim, do not pad.

Design constraints already built into the bar, do not work around them in the copy:
- Phone text is 13px and shows `mobileText`. A four-line clamp in
  `assets/css/announcement.css` is only a safety net for an old announcement with
  none.
- The cyan "Read it" label only shows on laptops. On phones it is a round arrow,
  so never rely on the `cta` wording to carry meaning.
- No emoji, no trailing arrow or "link" words in `text`. The sentence is itself the link.

## Step 3: Confirm

Show the user exactly this and wait for a yes (one AskUserQuestion, with the
option to edit the text):

```
Text:  <text>
Phone: <mobileText>
CTA:   <cta>
Link:  <href>
Runs:  <startsOn> to <end date>  (<durationDays> days)
```

## Step 4: Write

Write `content/announcement.json` with these keys:

```json
{
  "_readme": "<keep the existing _readme line>",
  "id": "<slug>-<YYYY-MM-DD>",
  "kind": "post | lab",
  "text": "...",
  "mobileText": "...",
  "cta": "...",
  "href": "...",
  "startsOn": "<today, YYYY-MM-DD>",
  "durationDays": 7
}
```

The `id` must be new every time. A visitor who dismissed the last announcement
stays dismissed for the same `id`, so reusing one hides the new banner from them.
Validate the file parses (`python3 -c "import json;json.load(open('content/announcement.json'))"`).

Then update the hint. `assets/js/announce-hint.js` is a tiny head script that tells
the page, before first paint, that a bar is coming, so the page holds the bar's space
and does not jump when the bar appears. It carries a copy of three fields on one line.
Replace that line, keeping the rest of the file untouched:

```js
    var ANN = {"id":"<id>","startsOn":"<startsOn>","durationDays":<durationDays>};
```

(Exactly those three keys, same values as the JSON, valid JSON on that single line.)
Then run `node --test 'tests/**/*.test.mjs'`. `tests/announce-hint.test.mjs` fails if the
hint and the JSON disagree. If a hint is ever stale the page still works, only the
small layout shift comes back.

## Step 5: Report

Say what was written and when it ends. Tell the user to preview it on
`http://localhost:5173` (hard-refresh, and clear the `ann-dismissed` key in
localStorage if they dismissed the old one). Offer `/ship` then `/publish` to
make it live. Do not run them unless asked.
