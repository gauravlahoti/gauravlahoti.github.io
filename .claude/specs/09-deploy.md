# Spec: Deploy (GitHub Pages + Custom Domain + OG Image)

## Overview

Ship the site. Push to GitHub, enable Pages, and walk
through the custom domain DNS setup. Replace placeholder OG
image and favicon with real ones. Add a GitHub Actions
workflow that deploys on every push to `main` (so future
content updates require no manual steps).

## Depends on

- Specs 01–08 (complete site).
- User input: GitHub repo name, custom domain (when ready).

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — final OG meta tags, Twitter card
  tags, structured data (JSON-LD `Person` schema).

## Files to change

- `index.html` — add `<meta property="og:*">`, Twitter
  card meta, JSON-LD `Person` schema. Concrete values:
  ```
  {
    "@context": "https://schema.org",
    "@type": "Person",
    "name": "Gaurav Lahoti",
    "jobTitle": "Senior Cloud & AI Architect",
    "worksFor": { "@type": "Organization", "name": "Deloitte" },
    "alumniOf": { "@type": "CollegeOrUniversity",
                  "name": "Institute of Engineering and Technology" },
    "address": { "@type": "PostalAddress",
                 "addressLocality": "Gurugram",
                 "addressCountry": "IN" },
    "email": "gaurav.lahoti25@gmail.com",
    "sameAs": [
      "https://www.linkedin.com/in/glahoti/",
      "https://github.com/gauravlahoti",
      "https://topmate.io/gaurav_lahoti12"
    ]
  }
  ```
- `assets/img/og-image.png` — replace placeholder with a
  real 1200×630 PNG (final hero composition).
- `assets/img/favicon.svg` — replace placeholder if a real
  brand mark is provided.

## Files to create

- `.github/workflows/deploy.yml` — GitHub Actions workflow
  that deploys to Pages on push to `main`. Uses
  `actions/deploy-pages@v4`. No build step (static site).
- `CNAME` — at repo root, contains the custom domain (only
  added once the user provides one).

## New dependencies

None.

## Rules for implementation

- The deploy workflow runs only on `main`.
- The workflow uploads the entire repo root as the artifact
  (no build, no exclusions beyond `.git`, `.claude`, `node_modules`).
- HTTPS is enforced — verify in GitHub Pages settings after
  first deploy.
- Custom domain setup is documented in `README.md` with the
  exact DNS records (ANAME or four A records to GitHub Pages
  IPs + CNAME for `www`).
- The `CNAME` file commits only when the user has the domain
  in hand; otherwise this spec ships without it and the site
  lives at `<user>.github.io/<repo>`.
- OG image must include the user's name, title, and the
  tagline so social previews are scannable at thumbnail size.

## Definition of done

- [ ] GitHub repo exists and `main` is pushed.
- [ ] Pages is enabled with the GitHub Actions source.
- [ ] First deploy succeeds; site is reachable at
      `<user>.github.io/<repo>` over HTTPS.
- [ ] Pushing a content change to `main` triggers a deploy
      that lands within 2 minutes.
- [ ] OG preview (verified via
      `https://www.opengraph.xyz/`) shows the real image,
      title, description.
- [ ] Twitter card preview renders correctly.
- [ ] JSON-LD `Person` schema validates at
      `https://validator.schema.org/`.
- [ ] If a custom domain is provided: site is reachable at
      `https://<domain>/` with a valid TLS cert; `www`
      redirects to apex (or vice versa, whichever is
      chosen).
- [ ] Lighthouse on production URL still hits the targets
      from spec 08.
