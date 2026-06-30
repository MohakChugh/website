# Mohak Chugh — Portfolio

A modern, dark-first, animated developer portfolio.

🔗 **Live:** https://mohakchugh.github.io/website

## Stack

- **Angular 22** — standalone components, signals, zoneless change detection,
  new control flow (`@if`/`@for`/`@defer`), SSG prerendering
- **spartan-ng** (shadcn/ui port for Angular) + **Tailwind CSS v4** (OKLCH tokens)
- Self-hosted **Geist** + **Inter** + **Geist Mono** variable fonts
- **lucide** icons via `@ng-icons`
- Dark-first theme with a cyan→violet accent and a light-mode toggle

## Features

- Floating glass nav (mobile sheet drawer), animated dot-grid + aurora background
- Scroll-reveal animations, rotating-role hero, View Transitions between routes
- **"Ask me anything" command palette** (⌘K) — local keyword-scored Q&A, no backend
- Projects grid + per-project detail pages (prerendered)
- CV with PDF export (`html2pdf`, lazy-loaded), Contact with social cards
- All motion respects `prefers-reduced-motion`

## Develop

```bash
nvm use            # Node 24 (see .nvmrc)
npm install
npm start          # dev server at http://localhost:4200
```

## Test & build

```bash
npm run test:unit      # Vitest unit tests
npm run build          # production build (SSG, dist/portfolio/browser)
npm run build:ghpages  # build for GitHub Pages (base-href /website/, 404.html, .nojekyll)
```

## Deploy

Pushing to `master` triggers the GitHub Actions workflow
(`.github/workflows/deploy.yml`), which runs `build:ghpages` and publishes
`dist/portfolio/browser` to GitHub Pages.
