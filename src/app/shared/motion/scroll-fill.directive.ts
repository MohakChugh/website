import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { prefersReducedMotion } from './env';

/**
 * Word-by-word scroll fill: splits the element's text into word spans and lights
 * each one (dim → bright) as the element scrolls up through the viewport.
 * Driven by a single rAF-throttled scroll handler writing `.lit` classes.
 *
 * Usage: `<p class="..." appScrollFill>Some statement to reveal word by word.</p>`
 */
@Directive({ selector: '[appScrollFill]' })
export class ScrollFillDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      const node = this.el.nativeElement;
      const text = (node.textContent ?? '').trim();
      if (!text) return;

      // Split into word spans.
      const words = text.split(/\s+/);
      node.textContent = '';
      const spans = words.map((w: string) => {
        const s = document.createElement('span');
        s.textContent = w;
        s.className = 'fill-word';
        node.append(s, document.createTextNode(' '));
        return s;
      });

      if (prefersReducedMotion()) {
        spans.forEach((s: HTMLSpanElement) => s.classList.add('lit'));
        return;
      }

      let raf = 0;
      const update = () => {
        raf = 0;
        const litCount = litWordCount(node.getBoundingClientRect(), window.innerHeight, spans.length);
        spans.forEach((s: HTMLSpanElement, i: number) => s.classList.toggle('lit', i < litCount));
      };
      const onScroll = () => {
        if (!raf) raf = requestAnimationFrame(update);
      };

      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      update();
      this.destroyRef.onDestroy(() => {
        cancelAnimationFrame(raf);
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
      });
    });
  }
}

/**
 * Pure helper: how many of `total` words should be lit given the element's
 * viewport rect. Fill maps the element travelling from 80% → 35% of viewport
 * height to 0 → 100% lit. Exported for unit testing.
 */
export function litWordCount(
  rect: { top: number; height: number },
  viewportH: number,
  total: number,
): number {
  const start = viewportH * 0.8; // begins filling when top passes 80% down
  const end = viewportH * 0.35; // fully lit when top reaches 35% down
  const progress = (start - rect.top) / (start - end);
  const clamped = Math.max(0, Math.min(1, progress));
  return Math.round(clamped * total);
}
