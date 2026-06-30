import {
  afterNextRender,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
} from '@angular/core';

/**
 * Scroll-reveal: adds `.is-visible` when the element enters the viewport, so the
 * `.reveal` CSS transition (defined in styles.css) plays once. SSR-safe
 * (browser-only via afterNextRender), self-cleaning, and respects an optional
 * stagger delay. Falls back to immediately visible if IntersectionObserver is
 * unavailable.
 *
 * Usage: `<div class="reveal" appReveal [revealDelay]="120">…</div>`
 */
@Directive({
  selector: '[appReveal]',
})
export class RevealDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  /** stagger delay in ms applied as transition-delay */
  readonly revealDelay = input(0, { alias: 'revealDelay' });

  constructor() {
    afterNextRender(() => {
      const node = this.el.nativeElement as HTMLElement;
      const delay = this.revealDelay();
      if (delay) {
        node.style.transitionDelay = `${delay}ms`;
      }

      const reduceMotion =
        typeof matchMedia !== 'undefined' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (typeof IntersectionObserver === 'undefined' || reduceMotion) {
        node.classList.add('is-visible');
        return;
      }

      const reveal = () => node.classList.add('is-visible');

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              reveal();
              observer.unobserve(node);
            }
          }
        },
        { threshold: 0.1, rootMargin: '0px 0px -8% 0px' },
      );

      observer.observe(node);

      // Safety net: never leave content permanently hidden if the observer
      // doesn't fire (e.g. off-screen content captured for PDF, or odd
      // layout/scroll containers). Reveal after a short grace period.
      const safety = setTimeout(reveal, 2500);

      this.destroyRef.onDestroy(() => {
        observer.disconnect();
        clearTimeout(safety);
      });
    });
  }
}
