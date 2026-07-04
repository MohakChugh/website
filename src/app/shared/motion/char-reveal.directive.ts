import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';
import { prefersReducedMotion } from './env';

/**
 * Per-character heading reveal: splits the element's text into `.char` spans
 * with a cascading transition-delay, then adds `.lit` when scrolled into view
 * so the letters wave up one by one (CSS in styles.css does the motion).
 *
 * Only safe on elements whose content is plain text (headings). Elements with
 * child elements are left untouched except for a plain fade via `.lit`.
 *
 * Usage: `<h2 class="char-reveal" appCharReveal>Featured Projects</h2>`
 */
@Directive({ selector: '[appCharReveal]' })
export class CharRevealDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  /** per-char stagger in ms */
  readonly charStagger = input(28);

  constructor() {
    afterNextRender(() => {
      const node = this.el.nativeElement;

      if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
        node.classList.add('lit');
        return;
      }

      // Split only when content is pure text — otherwise fall back to fade.
      if (node.children.length === 0) {
        const chars = splitChars(node.textContent ?? '');
        node.textContent = '';
        chars.forEach((ch, i) => {
          const s = document.createElement('span');
          s.className = 'char';
          s.textContent = ch;
          if (ch === ' ') s.style.whiteSpace = 'pre';
          s.style.transitionDelay = `${i * this.charStagger()}ms`;
          node.appendChild(s);
        });
      }

      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              node.classList.add('lit');
              observer.unobserve(node);
            }
          }
        },
        { threshold: 0.4 },
      );
      observer.observe(node);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}

/** Pure: split text into characters, preserving spaces. Exported for tests. */
export function splitChars(text: string): string[] {
  return [...text.trim()];
}
