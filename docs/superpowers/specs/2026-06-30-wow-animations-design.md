# WOW-Factor Animation System — Design Spec

Date: 2026-06-30
Branch: `redesign-angular-modern`

## Goal

Add a cohesive, high-impact ("maximum showpiece") animation layer to the portfolio
— hover + scroll + cursor effects — that feels intentional and stays 60fps, never
janky. All motion respects `prefers-reduced-motion`; cursor/tilt effects are
desktop + fine-pointer only.

## Motion language (shared by all effects)

- Easing: `--ease-out-expo` (entrances), `--ease-spring` (interactions) — already defined.
- Timings: 200ms micro / 400ms medium / 700ms reveal.
- Animate only `transform` / `opacity` / `color`; `will-change` used sparingly; scroll
  + pointer work throttled to `requestAnimationFrame`.
- Guards: every effect no-ops under `prefers-reduced-motion: reduce`; pointer-driven
  effects no-op when `matchMedia('(pointer: coarse)')` (touch). SSR-safe via
  `afterNextRender`, self-cleaning via `DestroyRef`.

## Components & directives (each isolated, reusable, testable)

1. **CursorComponent** (`app-cursor`, in app shell) — blend-mode dot trailing the pointer
   with spring lag; grows into a ring over `a`/`button`/`[data-cursor]`; hides native
   cursor on desktop only. rAF-driven, uses `motion` springs.
2. **TiltDirective** (`appTilt`) — 3D tilt toward cursor (`rotateX/Y`, `preserve-3d`) +
   a mouse-following radial spotlight glow (CSS vars `--mx/--my`) + sheen. Applied to
   project cards, skill cards, social cards, Ask-me input.
3. **ScrollFillDirective** (`appScrollFill`) — splits text into word `<span>`s; a single
   scroll handler sets a `--progress` CSS var; words interpolate dim→bright gradient.
   Applied to a hero statement line and section intro lines.
4. **MagneticDirective** (`appMagnetic`) — element translates toward cursor within a
   radius, springs back on leave (uses `motion`). Applied to primary CTAs + Ask-me input.
5. **CountUpDirective** (`appCountUp`) — counts a number from 0 to target when scrolled
   into view (IntersectionObserver + rAF easing). Used by the new stats strip.
6. **ScrambleDirective / component** (`appScramble`) — text-scramble settle-in for the
   hero name + rotating role on first load.
7. **Animated gradient border** — CSS-only conic-gradient rotating border utility
   (`.border-animate`) for featured cards + primary buttons on hover.

## Page-level changes

- **Hero:** staggered load-in of elements; name + role scramble on load; Ask-me input
  gets magnetic + tilt; rotating-role unchanged.
- **Background:** aurora gains a slow drift keyframe; dot-grid gets a cursor-following
  light pocket (radial-gradient driven by `--mx/--my` on a fixed layer).
- **New "By the numbers" strip** on home (between Featured and Skills): animated
  count-up stats — e.g. `13 Projects`, `3+ Years @ Amazon`, `1B+ records/day`,
  `5MM+ employees`. Numbers live in profile data.
- **Project/skill/social cards:** `appTilt` + spotlight glow + animated border on featured.
- **CTAs:** `appMagnetic` + animated gradient border.

## Tech

- Pure CSS + small directives for items 2,3,5,6,7 (zero deps).
- Add **`motion`** (~5KB, successor to Motion One) — lazy-loaded, desktop only — for
  spring physics in CursorComponent + MagneticDirective only.
- No Lenis / scroll-hijack. No GSAP.

## Performance / accessibility guardrails

- Target: 60fps interactions; Lighthouse perf stays ≥ 95; initial transfer stays ~140KB
  gz (motion lazy-loaded so it's off the critical path).
- Full `prefers-reduced-motion` and touch fallbacks: site is fully usable and good-looking
  with every animation disabled.

## Testing

- Vitest unit tests for pure logic: ScrollFill word-progress math, CountUp easing/format.
- Playwright visual checks: hero load, card tilt/glow, magnetic CTA, stats count-up,
  cursor on desktop, and a reduced-motion pass.

## Out of scope

- Pinned/scroll-scrub storytelling sections (can come later if wanted).
- Page-level 3D/WebGL.
