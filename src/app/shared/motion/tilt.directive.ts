import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';
import { pointerMotionEnabled } from './env';

/**
 * 3D tilt toward the cursor + a mouse-following spotlight glow. Sets CSS vars
 * --rx/--ry (rotation) and --mx/--my (glow position) consumed by `.tilt` /
 * `.tilt-glow` in styles.css. Desktop + fine-pointer only; no-ops otherwise.
 *
 * Usage: `<div class="tilt tilt-glow" appTilt>…</div>`
 */
@Directive({ selector: '[appTilt]' })
export class TiltDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  /** maximum tilt in degrees */
  readonly tiltMax = input(8, { alias: 'tiltMax' });

  constructor() {
    afterNextRender(() => {
      if (!pointerMotionEnabled()) return;
      const node = this.el.nativeElement;
      let raf = 0;

      const onMove = (e: PointerEvent) => {
        const rect = node.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width; // 0..1
        const py = (e.clientY - rect.top) / rect.height; // 0..1
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const max = this.tiltMax();
          node.style.setProperty('--rx', `${(px - 0.5) * 2 * max}deg`);
          node.style.setProperty('--ry', `${-(py - 0.5) * 2 * max}deg`);
          node.style.setProperty('--mx', `${px * 100}%`);
          node.style.setProperty('--my', `${py * 100}%`);
        });
      };

      const reset = () => {
        cancelAnimationFrame(raf);
        node.style.setProperty('--rx', '0deg');
        node.style.setProperty('--ry', '0deg');
      };

      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerleave', reset);
      this.destroyRef.onDestroy(() => {
        cancelAnimationFrame(raf);
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerleave', reset);
      });
    });
  }
}
