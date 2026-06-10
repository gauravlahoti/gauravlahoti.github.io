#!/usr/bin/env node
// gen-post-pages.mjs — generates static insight pages from content/posts.json.
// Run: node scripts/gen-post-pages.mjs
// Also called by /add-post after prepending a new post entry.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .trim()
        .slice(0, 60)
        .replace(/-+$/, "");
}

function esc(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function truncate(text, len) {
    if (text.length <= len) return text;
    return text.slice(0, len).replace(/\s+\S*$/, "") + "…";
}

function formatDate(dateStr) {
    const d = new Date(dateStr + "T12:00:00Z");
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

const postsPath = join(ROOT, "content", "posts.json");
const posts = JSON.parse(readFileSync(postsPath, "utf8"));

// Stamp slugs onto entries that don't have one yet, then persist.
let dirty = false;
for (const post of posts) {
    if (!post.slug) {
        post.slug = slugify(post.firstLine);
        dirty = true;
    }
}
if (dirty) {
    writeFileSync(postsPath, JSON.stringify(posts, null, 2) + "\n");
    console.log("Updated content/posts.json with slugs.");
}

const ASSET_V = "200";
const FONT_INTER_SRI = "sha384-STiTZ2kjdnc/em4jSELZZ6VypRToc92cA0m6Nppx3J8C4mt0fjMNUm1xnm1yoP96";
const FONT_JB_SRI = "sha384-8X0qYYsBdYZ9bk70hw4HTDsWIeMfYCwYmUcsezfamiqI024ZDkBKbaTx68Kwh6wx";

for (const post of posts) {
    const { slug, firstLine, excerpt, date, tags = [], url } = post;
    if (!slug) continue;

    const titleEsc = esc(firstLine);
    const desc = esc(truncate(excerpt || firstLine, 155));
    const canonical = `https://gauravlahoti.dev/insights/${slug}/`;
    const formattedDate = date ? formatDate(date) : "";
    const liUrl = url.split("?")[0];
    const liUtm = `${liUrl}?utm_source=site&utm_medium=insight&utm_campaign=${slug}`;

    const paragraphs = (excerpt || "")
        .split(/\n\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `                <p>${esc(p)}</p>`)
        .join("\n");

    const tagsHtml = tags
        .map((t) => `<span class="insight-tag">#${esc(t)}</span>`)
        .join(" ");

    const jsonLd = JSON.stringify(
        {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: firstLine,
            datePublished: date || undefined,
            author: { "@type": "Person", name: "Gaurav Lahoti", url: "https://gauravlahoti.dev/" },
            publisher: { "@type": "Person", name: "Gaurav Lahoti", url: "https://gauravlahoti.dev/" },
            url: canonical,
            mainEntityOfPage: canonical,
            keywords: tags,
        },
        null,
        2
    );

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
    <meta name="theme-color" content="#000000">
    <title>${titleEsc} | Gaurav Lahoti</title>
    <meta name="description" content="${desc}">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="${titleEsc}">
    <meta property="og:description" content="${desc}">
    <meta property="og:image" content="https://gauravlahoti.dev/assets/img/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:url" content="${canonical}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Gaurav Lahoti">
    ${date ? `<meta property="article:published_time" content="${date}">` : ""}
    <meta property="article:author" content="https://www.linkedin.com/in/glahoti/">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${titleEsc}">
    <meta name="twitter:description" content="${desc}">
    <meta name="twitter:image" content="https://gauravlahoti.dev/assets/img/og-image.png">
    <base href="/">
    <link rel="icon" type="image/svg+xml" href="assets/img/favicon.svg">
    <link rel="preconnect" href="https://rsms.me">
    <link rel="stylesheet" href="https://rsms.me/inter/inter.css"
          integrity="${FONT_INTER_SRI}" crossorigin="anonymous">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.0.20/index.css"
          integrity="${FONT_JB_SRI}" crossorigin="anonymous">
    <link rel="stylesheet" href="assets/css/base.css?v=${ASSET_V}">
    <link rel="stylesheet" href="assets/css/layout.css?v=${ASSET_V}">
    <link rel="stylesheet" href="assets/css/components.css?v=${ASSET_V}">
    <link rel="stylesheet" href="assets/css/insight.css?v=${ASSET_V}">
    <script type="application/ld+json">
${jsonLd}
    </script>
</head>
<body>
    <a class="skip-link" href="#insight-main">Skip to content</a>

    <header class="nav" role="banner">
        <div class="nav-inner">
            <a class="nav-brand" href="/">Gaurav Lahoti</a>
            <button class="nav-menu-trigger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="nav-drawer" data-nav-trigger>
                <span class="nav-menu-trigger-bar" aria-hidden="true"></span>
                <span class="nav-menu-trigger-bar" aria-hidden="true"></span>
                <span class="nav-menu-trigger-bar" aria-hidden="true"></span>
            </button>
            <nav class="nav-links" aria-label="Primary">
                <a href="/#career">Career</a>
                <a href="/#about">About</a>
                <a href="/#perspectives" class="nav-link-active" aria-current="page">Insights</a>
                <a href="/live-agents/">Live Agents</a>
            </nav>
            <div class="nav-actions">
                <ul class="nav-channels" aria-label="Channels">
                    <li>
                        <a class="nav-channel" href="mailto:gaurav.lahoti25@gmail.com" aria-label="Email">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
                        </a>
                    </li>
                    <li>
                        <a class="nav-channel" href="https://www.linkedin.com/in/glahoti/" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z"/></svg>
                        </a>
                    </li>
                    <li>
                        <a class="nav-channel" href="https://github.com/gauravlahoti" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
                        </a>
                    </li>
                </ul>
                <a class="nav-cta btn btn-ghost btn-sm" href="https://topmate.io/gaurav_lahoti25" target="_blank" rel="noopener noreferrer">
                    <span>Let's Talk</span>
                </a>
            </div>
        </div>
    </header>

    <aside class="nav-drawer" id="nav-drawer" aria-hidden="true" data-nav-drawer>
        <div class="nav-drawer-backdrop" data-nav-close aria-hidden="true"></div>
        <div class="nav-drawer-panel" role="dialog" aria-modal="true" aria-label="Site navigation">
            <button class="nav-drawer-close" type="button" aria-label="Close menu" data-nav-close>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18"/>
                </svg>
            </button>
            <nav class="nav-drawer-links" aria-label="Sections">
                <a href="/#career">Career</a>
                <a href="/#about">About</a>
                <a href="/#perspectives">Insights</a>
                <a href="/live-agents/">Live Agents</a>
            </nav>
            <a class="nav-drawer-cta btn btn-ghost" href="https://topmate.io/gaurav_lahoti25" target="_blank" rel="noopener noreferrer">
                <span>Let's Talk</span>
            </a>
        </div>
    </aside>

    <main id="insight-main" class="insight-main">
        <div class="insight-container">
            <nav class="insight-breadcrumb" aria-label="Breadcrumb">
                <a href="/#perspectives" class="insight-back">
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
                    All insights
                </a>
            </nav>

            <article class="insight-article" itemscope itemtype="https://schema.org/BlogPosting">
                <header class="insight-header">
                    <h1 class="insight-title" itemprop="headline">${titleEsc}</h1>
                    <div class="insight-meta">
                        ${formattedDate ? `<time class="insight-date" datetime="${date}" itemprop="datePublished">${formattedDate}</time>` : ""}
                        ${tagsHtml ? `<div class="insight-tags">${tagsHtml}</div>` : ""}
                        <a href="${esc(liUtm)}" target="_blank" rel="noopener noreferrer" class="insight-li-link">
                            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="currentColor">
                                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z"/>
                            </svg>
                            View on LinkedIn ↗
                        </a>
                    </div>
                </header>

                <div class="insight-body" itemprop="articleBody">
${paragraphs}
                </div>
            </article>

            <section class="insight-cta-section">
                <p class="insight-cta-eyebrow">// More from Gaurav</p>
                <div class="insight-cta-btns">
                    <a class="btn btn-primary" href="/">
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="7" width="18" height="13" rx="3"/>
                            <circle cx="8.5" cy="13" r="1.5" fill="currentColor" stroke="none"/>
                            <circle cx="15.5" cy="13" r="1.5" fill="currentColor" stroke="none"/>
                            <line x1="12" y1="3" x2="12" y2="7"/>
                            <circle cx="12" cy="2.5" r="1.2" fill="currentColor" stroke="none"/>
                        </svg>
                        Chat with my agent →
                    </a>
                    <a class="btn btn-outline-accent" href="/live-agents/">
                        View live agents →
                    </a>
                </div>
            </section>
        </div>
    </main>

    <footer class="footer" role="contentinfo">
        <div class="footer-inner">
            <span class="footer-copy">&copy; ${new Date().getFullYear()} Gaurav Lahoti</span>
            <a class="footer-link" href="mailto:gaurav.lahoti25@gmail.com">gaurav.lahoti25@gmail.com</a>
            <a class="footer-link" href="https://www.linkedin.com/in/glahoti/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
            <a class="footer-link" href="https://github.com/gauravlahoti" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
    </footer>

    <script>
    (function () {
        var trigger = document.querySelector("[data-nav-trigger]");
        var drawer = document.querySelector("[data-nav-drawer]");
        var closes = document.querySelectorAll("[data-nav-close]");
        if (!trigger || !drawer) return;
        function open() {
            trigger.setAttribute("aria-expanded", "true");
            drawer.setAttribute("aria-hidden", "false");
        }
        function close() {
            trigger.setAttribute("aria-expanded", "false");
            drawer.setAttribute("aria-hidden", "true");
        }
        trigger.addEventListener("click", function () {
            trigger.getAttribute("aria-expanded") === "true" ? close() : open();
        });
        closes.forEach(function (el) { el.addEventListener("click", close); });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    })();
    </script>
</body>
</html>`;

    const dir = join(ROOT, "insights", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    console.log(`  insights/${slug}/`);
}

console.log(`\nGenerated ${posts.length} insight pages.`);
