---
description: Fetch a LinkedIn post's title, get user approval, then add it to the Perspectives section
argument-hint: "LinkedIn post URL"
allowed-tools: Read, Write, Edit, Bash(node:*), AskUserQuestion
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

Print a brief preview to chat (markdown, not a tool call):

> **Parsed from LinkedIn**
>
> - **Title:** `{firstLine}`
> - **Date:** `{date}`
> - **Tags:** `{tags.map(t => "#" + t).join(" ")}` *(or "none detected" if empty)*
> - **Excerpt:** `{excerpt}` *(truncate to ~200 chars in the preview if longer)*
> - **URL:** `{url}`

## Step 5 — Get explicit approval

Use **AskUserQuestion** with these options:

1. **Add as-is** — write the entry to `posts.json` unchanged.
2. **Edit the title** — let the user override the firstLine before writing.
3. **Edit the date** — let the user override the date.
4. **Cancel** — abort, don't touch anything.

If the user picks "Edit the title" or "Edit the date", ask in chat for
the new value, update the `entry` object, then go back to Step 4 with
the updated entry. Loop until the user picks "Add as-is" or "Cancel".

## Step 6 — Write to posts.json (only on "Add as-is")

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

## Step 8 — On cancel

If the user cancels at any point, leave `posts.json` untouched and
print a single line:

```
Cancelled. No changes made.
```
