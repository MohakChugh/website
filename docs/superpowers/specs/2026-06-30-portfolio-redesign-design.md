# Portfolio Redesign & Angular Modernization — Design Spec

Date: 2026-06-30
Author: Mohak (with Claude)
Branch: `redesign-angular-modern`

## Goal

Rebuild the Angular 9 / Bootstrap 4 / jQuery portfolio as a modern, dark-first,
animated single-developer portfolio on the latest Angular, using spartan-ng
(the shadcn/ui port for Angular) + Tailwind v4. Three hard success criteria:

1. Complete modernization to the latest Angular features.
2. Complete UI overhaul with mobile-friendly components.
3. Reduced UI latency.

## Stack decisions (verified against npm 2026-06-30)

| Layer | Choice | Notes |
|---|---|---|
| Framework | Angular 22.0.x | standalone, signals, zoneless, new control flow, `@defer` |
| UI library | spartan-ng 1.0.2 (helm) | requires Angular >=21 <23 + Tailwind v4; shadcn aesthetic |
| CSS | Tailwind v4.3.x via `@tailwindcss/postcss` + `.postcssrc.json` | OKLCH design tokens |
| Icons | `@ng-icons/core` + `@ng-icons/lucide` | replaces Font Awesome 4 + Ionicons |
| Fonts | self-hosted `@fontsource-variable` Geist + Inter + Geist Mono | Geist display, Inter body, Geist Mono labels |
| HTTP | `provideHttpClient(withFetch())` | removes axios |
| PDF | html2pdf.js (kept) | CV export |
| Animation | Tailwind transitions + IntersectionObserver reveal directive + Router `withViewTransitions()` | no heavy libs; `@formkit/auto-animate` only if needed |
| Build | `@angular/build:application` (esbuild), SSG `outputMode: static` + `RenderMode.Prerender` | GitHub Pages `/website/` subpath, hash routing kept |
| Lint/Test/E2E | angular-eslint / Vitest / Playwright | replaces TSLint / Karma / Protractor |

## Theme

- Dark-first: `<html class="dark">` from first paint (no flash).
- Monochrome OKLCH neutrals + single accent: **cyan→violet gradient** on name + CTAs.
- Background: near-black + subtle dot-grid + slow radial aurora glow.
- Glassmorphism on floating nav and cards.

## Motion system (cohesive vocabulary)

- Easing: `cubic-bezier(0.22,1,0.36,1)` (expo-out) entrances; quick spring hovers.
- Durations: 200ms micro / 400ms medium / 700ms reveal.
- Patterns: scroll-reveal fade-up + stagger (IntersectionObserver); magnetic CTAs
  (translateY -2px + glow); hero rotating role word; animated stat counters;
  View Transitions on route change; card tilt/lift.
- All gated behind `prefers-reduced-motion`.

## Site map

- `/` Home — hero (rotating role, Ask-me input), featured projects, skills, signature Ask-me, footer
- `/projects` — 6-card grid
- `/projects/:slug` ×6 — verbatim content + GitHub/demo/PPT links
- `/cv` — full resume + html2pdf PDF export
- `/contact` — email + redesigned social section

### Content sources (ported verbatim from old app)

- Home: intro, 3 skill cards (Full Stack / DevOps & Cloud / Data Eng & ML), CTAs.
- Projects (slug → title → links):
  - `agritech` Farmers App / AgriTech — demo firebase, github mohakchugh/farmersapp, PPT
  - `citizens` Citizens App — demo citizensapp.firebaseapp.com, github MohakChugh/Citizensapp, PPT
  - `content-collaborator` Content Collaborator — github MohakChugh/Content-Collaborator
  - `property-management` Property Management — demo mnrproject.firebaseapp.com
  - `drone-dash` Drone Dash — demo dashboard.omnipresenttech.com, github MohakChugh/DroneDash
  - `classifier-selector` Classifier Selector — github MohakChugh/DataDashboards
- CV: 12 experience items, 2 education, 1 publication (DOI 10.1186/s13634-021-00754-2),
  contact card (DOB 17/07/1999, email me.mohakchugh@gmail.com, résumé bit.ly/mohakchughcv,
  AMCAT score drive link), skills bars (MEAN/DevOps/SoftSkills). The Amazon entry's blog
  link becomes plain text (blog removed).
- Contact: me.mohakchugh@gmail.com; socials GitHub MohakChugh, LinkedIn in/mohak-chugh-37a681141,
  Instagram mohak_projects, LinkedIn short bit.ly/mohakchughLinkedIN.

## Signature feature: "Ask me anything" palette

- ⌘K command palette + hero input with quick chips (Me / Projects / Skills / Experience / Contact).
- Powered by a LOCAL hardcoded Q&A knowledge base — no AI backend, no cost, offline, instant.
- Returns curated answers and can deep-link to sections. Architected so an LLM could be added later.

## Removed (with rationale)

- Live blog (`/blogs`, `/blog/:id`) — backend (Heroku) is dead (404).
- Admin delete route (`/blog/:username/:password`) — leaked credentials in URL (security smell).
- axios, jQuery, Bootstrap, Pikaday, Font Awesome, Ionicons — replaced per stack table.

## Performance plan (success criterion #3)

- Convert the two large GIFs (portfolio.gif 6.9MB, Dashboard_Demo.gif 7.7MB ≈ 14.6MB)
  to MP4/WebM + static poster (~95% reduction) — biggest single win.
- SSG prerender (instant first paint); zoneless; `@defer` below-the-fold; `NgOptimizedImage`
  priority hero; self-hosted fonts; lazy routes; drop jQuery/Bootstrap/axios.
- Targets: Lighthouse Perf ≥95 mobile; initial JS bundle < 250KB gz; LCP < 1.5s on broadband.

## Testing / verification

- Vitest unit tests for the Ask-me knowledge-base lookup and any logic.
- Playwright MCP visual check at desktop + mobile widths for each page.
- Build green (`ng build`), lint clean, prerender succeeds.

## Out of scope

- Real AI/LLM chat backend.
- Re-implementing a live blog CMS (could return later as static markdown).
