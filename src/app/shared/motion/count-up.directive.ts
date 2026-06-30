import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';
import { prefersReducedMotion } from './env';

/**
 * Counts from 0 to a target when the element scrolls into view (once).
 * Renders `prefix + number + suffix`. Reduced-motion shows the final value
 * immediately.
 *
 * Usage: `<span appCountUp [countTo]="1" suffix="B+"></span>`
 */
@Directive({ selector: '[appCountUp]' })
export class CountUpDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly countTo = input.required<number>();
  readonly prefix = input('');
  readonly suffix = input('');
  readonly durationMs = input(1400);

  constructor() {
    afterNextRender(() => {
      const node = this.el.nativeElement;
      const render = (n: number) =>
        (node.textContent = `${this.prefix()}${formatCount(n, this.countTo())}${this.suffix()}`);

      if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
        render(this.countTo());
        return;
      }

      render(0);
      let raf = 0;
      let startTs = 0;
      const target = this.countTo();
      const dur = this.durationMs();

      const tick = (ts: number) => {
        if (!startTs) startTs = ts;
        const t = Math.min(1, (ts - startTs) / dur);
        render(easeOutCubic(t) * target);
        if (t < 1) raf = requestAnimationFrame(tick);
      };

      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              raf = requestAnimationFrame(tick);
              observer.unobserve(node);
            }
          }
        },
        { threshold: 0.4 },
      );
      observer.observe(node);
      this.destroyRef.onDestroy(() => {
        cancelAnimationFrame(raf);
        observer.disconnect();
      });
    });
  }
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Format an interpolated value. Integer targets render as whole numbers;
 * fractional targets keep one decimal. Exported for unit testing.
 */
export function formatCount(current: number, target: number): string {
  return Number.isInteger(target) ? String(Math.round(current)) : current.toFixed(1);
}
