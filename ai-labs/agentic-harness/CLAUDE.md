# CLAUDE.md: Agentic Harness Lab (redirect stub)

Guidance for the **Agentic Harness** entry under `ai-labs/`. This is a redirect stub, not a
lab implementation. The repo-wide rules in the root `CLAUDE.md` still apply.

## What it is

`ai-labs/agentic-harness/index.html` redirects to `https://agentic-harness.gauravlahoti.dev/`,
a voiced guided tour of a from-scratch agent harness (spec 94). The code lives in its **own
repository**, `github.com/gauravlahoti/agentic-harness` (local clone `~/agentic-harness`), not in
this repo. Nothing here renders the lab.

The hosted copy runs the harness in **public tour mode** (`HARNESS_PUBLIC=1`, harness D-189):
it answers only GET/HEAD, holds no API key, and opens on the tour. Visitors never type a key.

## Hosting

| | |
|---|---|
| Service | Cloud Run `agentic-harness`, `gcp-experiments-490306`, us-central1 |
| Scale | min 0, max 1, 512Mi; secrets: `anthropic-api-key`, `harness-owner-key` (owner only) |
| Domain | `agentic-harness.gauravlahoti.dev` (Cloudflare CNAME → `ghs.googlehosted.com`, DNS-only) |
| Deploy | from `~/agentic-harness`: `make deploy-tour PROJECT=gcp-experiments-490306 HOSTS=<domain>,<run.app hosts> CLAUDE_SECRET=anthropic-api-key OWNER_SECRET=harness-owner-key MEMORY_BUCKET=gcp-experiments-490306-agentic-harness-memory` |
| Memory | bucket `gcp-experiments-490306-agentic-harness-memory` mounted at `/app/.agentic-harness` (facts, chats, online-evals switch, eval summaries; harness D-198). Leave out `MEMORY_BUCKET` and the new revision forgets it all |
| Owner | `?owner` + the `harness-owner-key` passphrase: live Claude runs, Memory, Observability (harness D-190, D-196, D-197) |

- **Deploy from the local clone, never from a fresh git clone.** The tour's voice clips are
  git-ignored on purpose. The harness's allowlist `.gcloudignore` uploads them and never `.env`.
- **Don't use `agents-cli deploy` for it.** It copies the project `.env`, which holds the Gemini key,
  into the service's environment.
- `HARNESS_ALLOWED_HOSTS` must list every name the service is reached by. A new domain needs a
  redeploy (or `gcloud run services update --update-env-vars`), or it answers 400.

## If you're changing this

- New domain: update both URLs in `index.html` (meta refresh + `location.replace`), the card's
  `href` stays `/ai-labs/agentic-harness/`, and update `content/agents.json` → `links`.
- The stub has the same shape as `ai-labs/rag-lab/` on purpose. See that lab's `CLAUDE.md` for why
  it's a redirect rather than a page here.
