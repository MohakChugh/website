# Markdown Blog System — HLD + LLD

Date: 2026-07-05 · Branch: `redesign-angular-modern` · Status: DESIGN (not implemented)

## Goal

A file-based blog: Mohak drops `.md` files into a folder; the build automatically
scans them and the site gains a fully styled, animated blog catalogue (`/blog`)
and reader (`/blog/:slug`) — dates, tags, excerpts, reading time — matching the
home page's theme (dark OKLCH, cyan→violet, frosted glass) and motion system
(reveal, tilt, char-reveal, link-wipe). No CMS, no backend, no manual
registration step.

## The governing constraint

The site is **SSG on GitHub Pages** (`outputMode: static`, no server). The old
blog died precisely because it depended on a live backend (Heroku). Therefore
everything must resolve at **build time**: markdown is discovered, parsed, and
rendered during the build, and every post becomes a prerendered static HTML
route — exactly the pattern already used for `projects/:slug` via
`getPrerenderParams`.

---

# High-Level Design

## Architecture: build-time content pipeline

```
content/blog/*.md                        (author writes here — source of truth)
        │
        ▼  scripts/generate-blog.mjs     (runs automatically via npm pre-hooks)
        │    • scan folder
        │    • parse frontmatter (title, date, tags, …)
        │    • validate hard (fail the build on bad content)
        │    • markdown → HTML (marked) + syntax highlighting (shiki, build-time)
        │    • compute excerpt + reading time
        ▼
src/app/data/blog.generated.ts           (gitignored, derived artifact)
        │    export const BLOG_POSTS: BlogPost[]  (sorted date desc)
        │    export const BLOG_MAP
        ▼
Angular (same patterns as projects):
  /blog        → BlogList page   (catalogue: filter by tag, featured latest)
  /blog/:slug  → BlogPost page   (reader: prose styling, progress bar, prev/next)
  app.routes.server.ts → getPrerenderParams over BLOG_POSTS → one static HTML per post
        │
        ▼  generator ALSO emits (kept in lockstep automatically):
  public/sitemap.xml   (regenerated: core routes + projects + blog URLs)
  public/feed.xml      (RSS 2.0)
  public/llms.txt      (blog section injected between marker comments)
```

### Decisions & rejected alternatives

1. **Build-time generation** (chosen) vs runtime fetch of `.md` (rejected: no
   prerendered content → destroys the SEO work; ships a markdown parser to the
   client; loading flashes) vs migrating to AnalogJS content routing (rejected:
   replaces the entire proven build for one feature).
2. **Date comes from frontmatter, required.** File mtime is NOT usable: git does
   not preserve mtimes, so CI checkouts would stamp every post with clone time.
   Explicit `date:` is validated at build.
3. **Filename = slug** (`rds-query-optimization.md` → `/blog/rds-query-optimization`).
   Deterministic, collision-free (one directory), validated kebab-case.
4. **Shiki at build time** for code highlighting: zero runtime JS, VS-Code-quality
   tokens, dark theme mapped to the site palette. (highlight.js at runtime rejected:
   bundle weight + hydration flash.)
5. **Generated file is gitignored**; npm `pre` hooks regenerate it for every
   `start`/`build`/`build:ghpages` locally and in CI. Markdown stays the single
   source of truth; no drift.
6. **`marked` + `gray-matter` + `shiki` as devDependencies only** — nothing new
   ships in the client bundle.
7. **Sitemap/RSS/llms.txt emitted by the generator** so publishing a post updates
   discovery surfaces (human + agent) with zero manual edits.

## Authoring workflow (the whole UX)

```bash
# 1. write
content/blog/how-i-cut-rds-queries-to-30s.md
# 2. preview            (prestart hook regenerates automatically)
npm start   → http://localhost:4200/blog/how-i-cut-rds-queries-to-30s
# 3. publish
git add . && git commit && git push   → CI regenerates → auto-deploys
```

No registration, no index editing, no config. Malformed posts fail the build
with a precise error (file, field, reason) rather than silently rendering wrong.

---

# Low-Level Design

## 1. Content format — `content/blog/<slug>.md`

```markdown
---
title: How I cut RDS query times from 20 minutes to 30 seconds
date: 2026-07-05            # required, ISO yyyy-mm-dd
tags: [aws, rds, performance]   # optional, default []
excerpt: Optional 1–2 line summary shown on cards and in meta description.
draft: true                 # optional; excluded from build output entirely
---

Markdown body. GFM: headings, lists, tables, images, blockquotes,
```java fenced code blocks``` (shiki-highlighted at build).
```

- Excerpt fallback: first paragraph, markdown-stripped, truncated ~160 chars.
- `readingMinutes = max(1, ceil(words / 200))`.
- Images live in `public/assets/blog/` and are referenced normally.

## 2. Generator — `scripts/generate-blog.mjs`

- Node ESM script; deps: `gray-matter`, `marked`, `shiki` (dev-only).
- Steps: read dir → for each file: validate filename `^[a-z0-9]+(-[a-z0-9]+)*\.md$`,
  parse frontmatter, validate (`title` non-empty string; `date` parses as ISO;
  `tags` array of strings), skip `draft: true` (log a notice), render markdown
  with a `marked` renderer whose code hook calls shiki (`codeToHtml`, theme
  mapped to the site's dark palette), compute excerpt/readingMinutes.
- **Exit non-zero with a per-file error report on any violation** — the failed
  build is the content test.
- Emit `src/app/data/blog.generated.ts` with header comment "GENERATED — do not
  edit", `BlogPost[]` sorted date-desc, and `BLOG_MAP`.
- Emit `public/sitemap.xml` (core + project + blog URLs; blog priority 0.7),
  `public/feed.xml` (RSS 2.0: title/link/pubDate/description per post), and
  splice a blog list into `public/llms.txt` between
  `<!-- BLOG:START -->` / `<!-- BLOG:END -->` markers.
- `package.json`: `"generate:blog": "node scripts/generate-blog.mjs"`, plus
  `prestart`, `prebuild`, `prebuild:ghpages` all invoking it. Add
  `src/app/data/blog.generated.ts` to `.gitignore`.

## 3. Data model — added to `portfolio.models.ts`

```ts
export interface BlogPost {
  slug: string;
  title: string;
  date: string;          // ISO, format in templates with DatePipe
  tags: string[];
  excerpt: string;
  readingMinutes: number;
  html: string;          // pre-rendered, pre-highlighted
}
```

## 4. Routing & SSG

```ts
// app.routes.ts
{ path: 'blog', loadComponent: () => import('./pages/blog/blog-list')…,
  data: { seo: { title: 'Blog — Mohak Chugh · Engineering Notes', description: …, path: '/blog' } } }
{ path: 'blog/:slug', loadComponent: () => import('./pages/blog/blog-post')… }
// component sets SEO dynamically (same as ProjectDetail)

// app.routes.server.ts
{ path: 'blog/:slug', renderMode: RenderMode.Prerender,
  getPrerenderParams: async () => BLOG_POSTS.map(p => ({ slug: p.slug })) }
```

Prerender count: 17 current routes + 1 (`/blog`) + N posts.

## 5. `BlogService` — `shared/blog.service.ts` (pure, unit-tested)

- `all(): BlogPost[]` (date desc) · `bySlug(slug)` · `tags(): {tag, count}[]`
- `filterByTag(tag | null)` · `adjacent(slug): { prev?, next? }`
- `search(query)` — same tokenizer/scoring approach as `AskService.searchProjects`,
  over title/tags/excerpt; wired into the ⌘K palette as a "Matching posts" group.

## 6. Catalogue UI — `pages/blog/blog-list` (mirrors home's language)

- Header: `eyebrow` "03 · Writing" · H1 `Recent <span class="text-ghost">Posts</span>`
  · intro line with `appScrollFill`.
- **Tag filter row**: mono chips (All + each tag with count); signal-driven
  client-side filter; active chip gets the gradient border.
- **Featured latest post**: full-width `glass-card border-animate` card (title,
  excerpt, date, reading time) with `appTilt` — the catalogue's hero.
- Remaining posts: 2-col grid of `glass-card tilt tilt-glow border-animate`
  cards with `appReveal` stagger — visually siblings of the project cards.
  Card anatomy: mono date eyebrow · `font-display` title (link-wipe on hover) ·
  `line-clamp-2` excerpt · tag chips · "X min read".
- Empty state (no posts / no tag matches): sparkles icon + quiet message,
  consistent with the palette's empty state.

## 7. Reader UI — `pages/blog/blog-post`

- `max-w-3xl` article. Back link ("← All posts", link-wipe). H1 with
  `appCharReveal` (flat text — the wave works). Meta row: date · reading time ·
  tag chips.
- Body: `[innerHTML]` of pre-rendered HTML through a `TrustHtmlPipe`
  (`bypassSecurityTrustHtml`) — **safe because content is build-time output of
  the repo owner's own markdown, never user input**; the pipe documents this.
- Typography: `@tailwindcss/typography` plugin (`@plugin` in styles.css) with a
  token-mapped override layer (`--tw-prose-body: var(--color-muted-foreground)`,
  headings `font-display`, links `link-wipe` + primary, code blocks frosted
  `glass-card`-style with rounded borders, blockquote with gradient left rule).
- **New micro-motion — `ScrollProgressDirective`**: fixed 2px top bar, cyan→violet
  gradient, `transform: scaleX(progress)` updated on rAF-throttled scroll;
  hidden under `prefers-reduced-motion`. Same guard/cleanup conventions as the
  other motion directives.
- Footer of the article: prev/next as two small glass cards (`adjacent()`).
- Dynamic SEO in the component (effect on the slug input): title = post title,
  description = excerpt, canonical `/blog/:slug`; `SeoService.apply` gains
  optional `{ type: 'article', publishedTime }` → emits `og:type=article` +
  `article:published_time`.

## 8. Site integration

- Navbar: add **Blog** (`lucideNotebookPen`) between Projects and CV; footer link
  list likewise. (Nav has room; mobile sheet inherits automatically.)
- ⌘K palette: BlogService.search results render as a compact "Matching posts" list.
- Ask-me knowledge base: one new entry ("Do you write?" → deep-link `/blog`).

## 9. Testing & verification

- **Generator**: hard validation IS the content gate (build fails loudly).
- **Vitest**: `BlogService` spec (sort order, tag filter, adjacent at both ends,
  search relevance) against a small fixture array; keeps the existing
  `--root src` setup (no test infra changes).
- **Gates**: tests green → `build:ghpages` green → prerender count = 18 + N →
  visual pass on localhost:4200 (catalogue + reader, desktop/mobile,
  reduced-motion) → **push only after user approval**, per standing instruction.

## 10. Scale ceiling (documented, not built — YAGNI)

All posts' HTML lives in one lazy chunk. Fine to roughly ~50 posts / ~500KB raw
(loaded only on /blog routes). Upgrade path when exceeded: generator emits one
module per post + a light index; reader lazy-imports per slug.
<!-- ponytail: single generated module. Upgrade: per-post modules past ~50 posts -->

## Out of scope

Comments, view counters, CMS UIs, server rendering, MDX/components-in-markdown,
full-text search index (palette search covers it).
