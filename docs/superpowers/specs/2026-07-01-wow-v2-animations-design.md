# WOW v2 — Award-Site Animation Upgrade

Date: 2026-07-01 · Branch: `redesign-angular-modern`

## Goal
Layer 7 new, high-impact effects on top of the existing motion system (tilt,
cursor, scroll-fill, scramble, magnetic, aurora) to reach award-site quality.
Keep the existing system; add, don't rebuild.

## The 7 effects
1. **Particle constellation hero** — canvas component (`app-particles`): drifting
   dots joined by faint lines when near; cursor repels nearby particles. Replaces
   the static dot-grid as the hero's living background layer. Desktop + no
   reduced-motion only; falls back to the existing static dot-grid.
2. **Parallax layers** — `appParallax` directive: element translates at a speed
   factor relative to scroll (single rAF scroll listener, transform-only).
   Applied to the hero watermark (slow) and aurora (fast).
3. **Horizontal-scroll project showcase** — Featured Projects becomes a pinned,
   scroll-driven horizontal strip on desktop (`lg+`): tall section + sticky inner
   + translateX driven by scroll progress. Mobile/tablet keeps the grid.
4. **Staggered character-reveal headings** — `appCharReveal` directive: splits
   heading text into chars; IntersectionObserver triggers a per-char slide-up
   wave (transform/opacity, ~30ms stagger).
5. **Animated gradient mesh** — upgrade `.bg-aurora` from 2 static radial blobs
   to 4 drifting orbs (pure CSS keyframes, lava-lamp feel).
6. **Link underline wipe** — `.link-wipe` utility: ::after scaleX(0→1) on hover.
   Applied to nav links, footer links, inline links.
7. **Page-enter choreography** — coordinated entrance: nav slides down once on
   load; per-page hero elements stagger in via existing reveal delays tightened
   into a sequence (bg → nav → heading → body → CTAs, ~800ms).

## Guards (same policy as v1)
Every effect no-ops under `prefers-reduced-motion`; pointer-driven pieces are
fine-pointer only; SSR-safe via afterNextRender; DestroyRef cleanup; only
transform/opacity/color animated; rAF-throttled scroll/pointer work.

## Testing
Unit tests for pure logic (parallax offset math, char-split). Build green,
Playwright visual pass when MCP available, else curl + DOM checks. 60fps target;
transfer stays ~140KB gz (no new deps).

## Out of scope
GSAP/Lenis/scroll-hijack; WebGL; rebuilding existing effects.
