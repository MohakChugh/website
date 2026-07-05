---
title: How I Built This Portfolio (and Its Blogging Engine) in Angular 22
date: 2026-07-05
tags: [angular, tailwind, spartan-ng, ssg, ai]
excerpt: A technical walkthrough of rebuilding my portfolio from Angular 9 to Angular 22 with spartan-ng, Tailwind v4, SSG prerendering, a WOW animation system, and a zero-backend blogging engine powered by markdown files.
---

## The starting point

My old portfolio was an Angular 9 app with Bootstrap 4 and jQuery — a 2020-era setup that hadn't aged well. The blog depended on a Heroku backend that had long since died (returning 404), the build tooling used TSLint and Protractor (both deprecated), and the entire dependency tree had 176 known vulnerabilities.

Time to burn it down and start fresh.

## Architecture decisions

### Angular 22 — standalone, zoneless, SSG

Rather than incrementally upgrading through 6 major versions (a recipe for pain), I scaffolded a fresh Angular 22 app and ported content into it. Key choices:

- **Standalone components** everywhere — no NgModules
- **Zoneless change detection** (`provideZonelessChangeDetection`) — smaller bundle, better performance
- **Static Site Generation** (SSG) via `outputMode: static` — every route is a prerendered HTML file. Perfect for GitHub Pages (no server needed)
- **Signals** for reactive state (the rotating-role hero, theme, Ask palette)

```typescript
// app.config.ts — the entire app bootstrap
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withViewTransitions(), withComponentInputBinding()),
    provideClientHydration(withEventReplay()),
    provideHttpClient(withFetch()),
  ],
};
```

### spartan-ng — the shadcn/ui port for Angular

I wanted the shadcn aesthetic (the reason React portfolios look so clean) but without leaving Angular. spartan-ng is the direct port: accessible primitives (`@spartan-ng/brain`) wrapped in Tailwind-styled "helm" components that you own in your source tree. The critical finding: **spartan-ng 1.0 requires Angular 21+ and Tailwind v4** (it dropped Angular 20 support days before I started).

### Tailwind v4 — OKLCH tokens, @theme inline, PostCSS

Tailwind v4's CSS-first config (`@theme inline`) maps custom properties to utilities. The dark-first OKLCH token system (cyan primary → violet gradient accent) works because spartan's preset ships the variant + mapping out of the box.

```css
:root {
  --primary: oklch(0.78 0.13 200);
  --grad-from: oklch(0.8 0.13 200);
  --grad-to: oklch(0.65 0.2 290);
}
```

## The WOW animation system

The motion layer is built from **6 reusable directives** + one canvas component, all sharing a coherent vocabulary:

1. **Custom cursor** — blend-mode dot + trailing ring, grows over links
2. **3D tilt + spotlight** — `appTilt` directive: cards rotate toward the cursor with a following radial glow
3. **Scroll word-fill** — `appScrollFill`: paragraph words light up dim→bright as you scroll past
4. **Magnetic buttons** — `appMagnetic`: elements pull toward the cursor and spring back (uses the `motion` library for springs)
5. **Text scramble** — `appScramble`: characters settle into place on first load
6. **Particle constellation** — `app-particles`: a living canvas of drifting dots joined by faint lines, reactively repelled by the cursor

Every effect is gated behind `prefers-reduced-motion` and `pointer: fine` (desktop only). The particles use a rAF loop on an offscreen canvas; everything else is pure CSS transitions driven by IntersectionObserver or pointer events.

## The "Ask me anything" palette — the signature feature

Instead of a static About section, the site has a **⌘K command palette** powered by a local keyword-scored knowledge base. No AI backend, no cost, instant, offline. Type "amazon" → it surfaces your work history. Type "drone" → matching project cards render inline.

The freshest touch: an "agent mode" easter egg. Ask "are you a bot?" → it responds with a playful reverse-CAPTCHA pointing to `/llms.txt` and `/api/profile.json`, making the portfolio machine-readable for AI agents and recruiter bots.

## The blogging engine (this very post)

The old blog died because it needed a live server. The new one **cannot die** — it's purely static. The architecture:

```
content/blog/*.md → scripts/generate-blog.mjs → blog.generated.ts → prerendered HTML
```

Drop a markdown file with frontmatter, push to GitHub, done. The generator:
- Parses frontmatter (title, date, tags, excerpt)
- Validates (malformed posts fail the build — not silently render wrong)
- Renders markdown with **Shiki** syntax highlighting at build time (VS-Code-quality tokens, zero runtime JS)
- Computes reading time
- Emits a TypeScript data file, a regenerated sitemap, and an RSS feed

The blog UI matches the home page exactly: frosted-glass cards, tilt + glow on hover, staggered scroll-reveal, a cyan→violet scroll-progress bar on the reader.

## Performance

The entire site (12 projects, full CV, 4 skill cards, blog, particles, animations) ships at **~141 KB gzipped** transfer. The two biggest wins:
- Converting 14.6 MB of animated GIFs → MP4 + tiny poster JPGs (~95% reduction)
- SSG prerendering (instant first paint, no client-side rendering wait)

## What I'd do differently

Looking back over this three-day build:
- I'd have gone with **path-based routing from the start** rather than hash routing (the later migration from hash → path was a chicken-and-egg headache with GitHub Pages)
- I'd have tested with a **real content post** earlier — the blog generator's Shiki integration surfaced a transient ESM import issue that only manifested on first real use

## Stack summary

| Layer | Choice |
|---|---|
| Framework | Angular 22 (standalone, zoneless, SSG) |
| UI | spartan-ng 1.0 + Tailwind v4 (OKLCH, dark-first) |
| Motion | 6 directives + particles canvas + `motion` lib |
| Icons | @ng-icons/lucide |
| Fonts | Geist + Inter + Geist Mono (self-hosted @fontsource) |
| Blog | Markdown → build-time HTML (marked + shiki + gray-matter) |
| Deploy | GitHub Pages via Actions (auto on push) |
| Domain | mohakchugh.is-a.dev (free, community dev domain) |
| Agent layer | /llms.txt + /api/profile.json |

The source is at [github.com/MohakChugh/website](https://github.com/MohakChugh/website).
