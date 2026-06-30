import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';
import { pointerMotionEnabled } from './env';

/**
 * Magnetic pull: the element translates toward the cursor while it hovers within
 * a radius, and springs back to rest on leave. Spring physics via the lazy-loaded
 * `motion` library (desktop only, off the critical path). No-ops on touch /
 * reduced-motion.
 *
 * Usage: `<a appMagnetic hlmBtn>…</a>`
 */
@Directive({ selector: '[appMagnetic]' })
export class MagneticDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  /** how far the element is pulled, as a fraction of cursor offset */
  readonly strength = input(0.4, { alias: 'magneticStrength' });

  constructor() {
    afterNextRender(async () => {
      if (!pointerMotionEnabled()) return;
      const node = this.el.nativeElement;
      const { animate } = await import('motion');

      const onMove = (e: PointerEvent) => {
        const rect = node.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = (e.clientX - cx) * this.strength();
        const dy = (e.clientY - cy) * this.strength();
        animate(node, { x: dx, y: dy }, { type: 'spring', stiffness: 300, damping: 20 });
      };

      const reset = () => {
        animate(node, { x: 0, y: 0 }, { type: 'spring', stiffness: 250, damping: 18 });
      };

      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerleave', reset);
      this.destroyRef.onDestroy(() => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerleave', reset);
      });
    });
  }
}
