---
name: portfolio-deploy-troubleshoot
description: Use when the user reports the portfolio site is broken in production - GitHub Pages deploy failed, 404s on the live URL, custom domain not resolving, HTTPS cert pending, OG preview wrong, or the GitHub Actions workflow is red. Walks through diagnosis (CNAME, DNS, .nojekyll, Pages settings, Actions logs) and fixes. Examples - "GitHub Pages deploy failed", "my site shows 404", "custom domain not working", "HTTPS not provisioned", "OG image not updating on LinkedIn".
---

# Portfolio deploy troubleshoot

The deploy stack is small but has six common failure modes.
Diagnose in this order.

## Step 1 — Is the workflow green?

```
gh run list --workflow=deploy.yml --limit 5
```

If the latest run failed, open it:

```
gh run view <run-id> --log-failed
```

Common failures:
- **Permissions error** — Settings → Pages → Source must be
  "GitHub Actions". Settings → Actions → Workflow permissions
  must allow read+write.
- **Artifact too large** — exclude `node_modules`, `.git`,
  `.claude` from the upload. Site assets shouldn't exceed
  100MB.

## Step 2 — Is the site reachable at the GH Pages URL?

```
curl -I https://<user>.github.io/<repo>/
```

- 200 → site is fine; problem is elsewhere.
- 404 → check that `index.html` is at repo root and
  `.nojekyll` exists. Pages serves Jekyll by default;
  `.nojekyll` opts out so files starting with `_` ship.

## Step 3 — Does the custom domain resolve?

```
dig +short <domain>
dig +short www.<domain>
```

Required records:
- Apex: ANAME / ALIAS to `<user>.github.io`, OR four A
  records to `185.199.108.153`, `185.199.109.153`,
  `185.199.110.153`, `185.199.111.153`.
- `www`: CNAME to `<user>.github.io`.

`CNAME` file at the repo root must contain the apex domain
(no protocol, no trailing slash).

DNS propagation can take up to 48h; usually 15-30 minutes.

## Step 4 — Is HTTPS provisioned?

GitHub Pages auto-provisions a Let's Encrypt cert once DNS
verifies. If pending after 24h:

- Settings → Pages → Custom domain → uncheck "Enforce HTTPS".
- Remove the custom domain.
- Wait 5 minutes.
- Re-add the custom domain.
- Re-check "Enforce HTTPS" once it lights up.

## Step 5 — OG preview wrong?

Social platforms cache aggressively.

- LinkedIn: paste URL into <https://www.linkedin.com/post-inspector/>
- Twitter: <https://cards-dev.twitter.com/validator>
- Facebook: <https://developers.facebook.com/tools/debug/>

Each has a "Refresh" button that refetches.

If the preview still shows the placeholder OG image:
- Confirm `index.html` references the new file path.
- Bump the query string: `<meta property="og:image" content="…/og-image.png?v=2">`
- Re-validate.

## Step 6 — Local cache lying to you?

Hard reload (`Cmd-Shift-R` / `Ctrl-Shift-F5`) or open the
URL in an incognito window. Service workers are not used in
this project, so a hard reload is enough.

## Recovery: nothing works, roll back

If a bad deploy is live:

```
git revert HEAD
git push origin main
```

Pages redeploys on push; rollback lands within a few
minutes.

## What NOT to do

- Don't disable Pages and re-enable to "fix" things — you'll
  invalidate the HTTPS cert and start the propagation clock
  over.
- Don't change the apex domain DNS while a deploy is in
  flight; finish one change at a time.
- Don't commit credentials, API keys, or `.env` files. The
  site is fully public.
