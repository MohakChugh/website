import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';
import { prefersReducedMotion } from './env';

const GLYPHS = '!<>-_\\/[]{}—=+*^?#________';

/**
 * Text-scramble settle-in: on first render, characters cycle through random
 * glyphs and resolve to the final text left-to-right. Reduced-motion shows the
 * text immediately.
 *
 * Usage: `<span appScramble>Mohak Chugh</span>`
 */
@Directive({ selector: '[appScramble]' })
export class ScrambleDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  /** ms before the scramble starts (for staggering) */
  readonly delayMs = input(0, { alias: 'scrambleDelay' });

  constructor() {
    afterNextRender(() => {
      const node = this.el.nativeElement;
      const target = (node.textContent ?? '').trim();
      if (!target || prefersReducedMotion()) return;

      let raf = 0;
      let frame = 0;
      const total = target.length;
      const settleAt = target.split('').map((_: string, i: number) => 8 + i * 2); // per-char resolve frame

      const run = () => {
        let out = '';
        let done = 0;
        for (let i = 0; i < total; i++) {
          if (frame >= settleAt[i]) {
            out += target[i];
            done++;
          } else if (target[i] === ' ') {
            out += ' ';
            done++;
          } else {
            out += GLYPHS[Math.floor((frame * 7 + i * 13) % GLYPHS.length)];
          }
        }
        node.textContent = out;
        frame++;
        if (done < total) raf = requestAnimationFrame(run);
      };

      const startId = setTimeout(() => (raf = requestAnimationFrame(run)), this.delayMs());
      this.destroyRef.onDestroy(() => {
        clearTimeout(startId);
        cancelAnimationFrame(raf);
      });
    });
  }
}
