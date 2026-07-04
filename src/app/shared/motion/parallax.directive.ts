import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';
import { prefersReducedMotion } from './env';

/**
 * Parallax: translates the element vertically at a fraction of the scroll
 * position, creating depth between layers. speed < 0 drifts opposite to
 * scroll; 0.2 means "move at 20% of scroll speed". transform-only, one
 * rAF-throttled scroll listener per instance.
 *
 * Usage: `<span appParallax [parallaxSpeed]="-0.15">…</span>`
 */
@Directive({ selector: '[appParallax]' })
export class ParallaxDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly parallaxSpeed = input(0.2);

  constructor() {
    afterNextRender(() => {
      if (prefersReducedMotion()) return;
      const node = this.el.nativeElement;
      let raf = 0;

      const update = () => {
        raf = 0;
        node.style.transform = `translate3d(0, ${parallaxOffset(window.scrollY, this.parallaxSpeed())}px, 0)`;
      };
      const onScroll = () => {
        if (!raf) raf = requestAnimationFrame(update);
      };

      window.addEventListener('scroll', onScroll, { passive: true });
      update();
      this.destroyRef.onDestroy(() => {
        cancelAnimationFrame(raf);
        window.removeEventListener('scroll', onScroll);
      });
    });
  }
}

/** Pure: pixel offset for a given scrollY and speed factor. Exported for tests. */
export function parallaxOffset(scrollY: number, speed: number): number {
  return Math.round(scrollY * speed * 100) / 100;
}
