---
name: run-site
description: Boot the static dev server and tell me the URL. Examples - "run the site", "start the dev server", "boot localhost".
argument-hint: "[port]"
context: fork
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion
---

> Forked from `.claude/commands/run-site.md`

Boot a local static server for the portfolio. Default port
5173 unless $ARGUMENTS provides one.

## Step 1 — Pick a port
Default to 5173. If $ARGUMENTS contains a number, use that.

## Step 2 — Check the port is free
Run `lsof -nP -iTCP:<port> -sTCP:LISTEN`. If something is
listening, ask the user whether to kill it or pick a different
port. Don't auto-kill.

## Step 3 — Boot the server
From the project root, run `python3 -m http.server <port>` in
the background.

Wait until `curl -fsS http://127.0.0.1:<port>/` succeeds, then
report:

```
Site:  http://localhost:<port>
PID:   <bg task id>
Stop:  use TaskStop or kill <pid>
```

## Step 4 — Hint
Suggest the user open the URL in a browser. Do not auto-open.
