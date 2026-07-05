import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { prefersReducedMotion } from './env';

/**
 * Scroll-progress bar: a fixed 2px top bar with a cyan→violet gradient that
 * scales with the scroll progress of the page. Hidden under reduced-motion.
 *
 * Usage: `<div appScrollProgress class="fixed top-0 inset-x-0 z-[100] h-0.5 origin-left bg-gradient-to-r from-[var(--grad-from)] to-[var(--grad-to)]"></div>`
 */
@Directive({ selector: '[appScrollProgress]' })
export class ScrollProgressDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      const node = this.el.nativeElement;
      if (prefersReducedMotion()) {
        node.style.display = 'none';
        return;
      }

      let raf = 0;
      const update = () => {
        raf = 0;
        const scrollH = document.documentElement.scrollHeight - window.innerHeight;
        const progress = scrollH > 0 ? Math.min(1, window.scrollY / scrollH) : 0;
        node.style.transform = `scaleX(${progress})`;
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
