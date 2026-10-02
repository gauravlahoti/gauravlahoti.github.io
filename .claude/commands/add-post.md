---
description: Fetch a LinkedIn post's title, get user approval, then add it to the Perspectives section
argument-hint: "LinkedIn post URL"
allowed-tools: Read, Write, Edit, Bash(node:*), AskUserQuestion, Skill
---

Add a LinkedIn post to `content/posts.json` (the data file that
drives the Perspectives section + nav flyout). Always show the parsed
title to the user and wait for explicit approval before writing.

User input: $ARGUMENTS — a single LinkedIn post URL.

## Step 1 — Validate the URL

Strip any leading/trailing whitespace from `$ARGUMENTS`. Reject anything
that isn't a single URL matching one of:

- `https://www.linkedin.com/posts/...`
- `https://www.linkedin.com/feed/update/...`

If invalid, print a one-line error and stop. Do not run the script.

## Step 2 — Fetch + parse via the helper

Run:

```
node scripts/add-post.mjs <url> --print
```

This emits the parsed entry as JSON on stdout, performs no writes, and
asks no questions. Branch on exit code:

- **0** — JSON is on stdout. Parse it as the `entry` object.
- **3** — Duplicate. The post is already in `posts.json`. Tell the user
  the firstLine reported on stderr and stop. Do not write.
- **4** — OG fetch failed. The post may be private, deleted, or
  LinkedIn is blocking the crawler UA. Skip to **Step 2b**.
- **2** — Bad URL. Re-do Step 1's validation (this shouldn't happen
  if Step 1 caught it).
- Anything else — print stderr to the user and stop.

### Step 2b — Manual fallback (only if exit code was 4)

Ask the user (one AskUserQuestion call) for:

- **firstLine** — the post's first line, max 120 chars
- **excerpt** — 1–3 sentence preview (optional, can be blank)
- **date** — `YYYY-MM-DD`, default today

Build the `entry` object: `{ url, firstLine, excerpt, date }`.

## Step 3 — Show the parsed entry

Tags are extracted automatically — no prompt needed. The script derives `tags` from the
LinkedIn post hashtags in the OG description text (preferred) or the URL slug (fallback).
Do not ask the user for a tag; do not pass `--tag` to the script.

The script strips LinkedIn's own preview counter (`| 15 comments on
LinkedIn`) from the excerpt. If one still shows at the end of the excerpt,
remove it before writing: it is LinkedIn chrome, not post text.

Print a brief preview to chat (markdown, not a tool call):

> **Parsed from LinkedIn**
>
> - **Title:** `{firstLine}`
> - **Date:** `{date}`
> - **Tags:** `{tags.map(t => "#" + t).join(" ")}` *(or "none detected" if empty)*
> - **Excerpt:** `{excerpt}` *(truncate to ~200 chars in the preview if longer)*
> - **URL:** `{url}`

## Step 4 — Suggest alternative titles (always)

The title becomes the post's headline in Perspectives and the nav flyout,
so always offer alternatives alongside the post's own first line. Read the
whole excerpt, then write **three** alternatives:

- Each says *what* the post is about, concretely. The post's first line is
  often a teaser ("The badges came after the building, not before.") that
  doesn't say what the badges are.
- Each takes a different angle: the big idea, the specific tech or result,
  the hook that pulls a reader in.
- Gaurav's voice: plain, first person, at most about 90 characters, no em
  dashes, no hype words ("revolutionary", "game-changer", "delve").
- Only facts in the post. Never invent a number, product or claim.
- Look at the other titles in `content/posts.json` for tone.

Also decide whether the original is already the best. If it's concrete and
punchy, recommend keeping it; if it's a teaser, recommend the strongest
alternative. Say why in one line.

Print them under the preview:

> **Title options**
>
> - **Original:** `{firstLine}`
> - **A:** `{alt1}`: *{one-line angle}*
> - **B:** `{alt2}`: *{angle}*
> - **C:** `{alt3}`: *{angle}*
> - **Recommendation:** {which one, and why in one line}

## Step 5 — Get explicit approval

Use **one AskUserQuestion call with two questions**:

1. **Title** (header "Title"): four options: the recommended one first,
   with "(Recommended)" in its label, then the others among the original
   and A/B/C. Put the full title text in each option's description. The
   user can pick "Other" to type their own.
2. **Action** (header "Add post"): **Add** (write with the chosen title),
   **Edit the date** (currently `{date}`), **Cancel**.

Set `entry.firstLine` to the chosen title. On "Edit the date", ask in chat
for the new `YYYY-MM-DD`, update `entry.date`, and ask again. Loop until
the user picks "Add" or "Cancel".

## Step 6 — Write to posts.json (only on "Add")

1. Read `content/posts.json`.
2. Parse JSON. If it's not an array, stop with an error.
3. **Re-check dedupe**: if any existing entry has `entry.url`, stop —
   tell the user it was added between fetch and write.
4. Prepend the new entry (newest-first ordering).
5. Write back as 2-space-indented JSON with a trailing newline.

## Step 7 — Report

Print:

```
Added to content/posts.json:
  • {firstLine}
  • {date}

Review:  git diff content/posts.json
Reload:  http://localhost:5173/  (hard-refresh; posts.json fetches with cache: "no-cache")
```

Do not commit. Do not bump asset versions — `posts.json` is data, not
code, and is fetched with `cache: "no-cache"` so a normal reload picks
it up.

## Step 7b — Refresh post metrics (always, only after a successful write)

After a successful "Add" write (never on Cancel or any error path),
**always invoke the `/refresh-post-metrics` skill** via the Skill tool so the
Perspectives engagement chips re-scrape. Do not ask — just run it.

⚠️ **Accuracy caveat — surface this to the user:** the metrics scraper reads
its post list from the **live** `https://gauravlahoti.dev/content/posts.json`
(see `agents/pulse/app/app_utils/post_metrics.py`), not your local file. So
this refresh updates counts for posts already live, but the post you just
added won't get a chip until it's been **published** (`/publish`). Tell the
user: "Refreshed existing posts; this new one will get its engagement chip
after `/publish` + the next refresh." If the user just wants existing counts
updated, this is already done; if they want the new post's chip, prompt them
to `/publish` first, then it'll be captured on the following refresh.

If `/refresh-post-metrics` fails (e.g. `gcloud` not authenticated), do **not**
fail the add — the post is already written. Report the refresh error
separately and remind the user they can re-run `/refresh-post-metrics` later.

## Step 8 — On cancel

If the user cancels at any point, leave `posts.json` untouched and
print a single line:

```
Cancelled. No changes made.
```
