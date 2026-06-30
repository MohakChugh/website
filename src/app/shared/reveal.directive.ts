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

      if (typeof IntersectionObserver === 'undefined') {
        node.classList.add('is-visible');
        return;
      }

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              node.classList.add('is-visible');
              observer.unobserve(node);
            }
          }
        },
        { threshold: 0.12, rootMargin: '0px 0px -10% 0px' },
      );

      observer.observe(node);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
