import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { pointerMotionEnabled } from './env';

/**
 * Custom cursor: a blend-mode dot that tracks the pointer exactly and a ring
 * that trails with eased lerp and grows over interactive elements. Desktop +
 * fine-pointer only; renders nothing (and leaves the native cursor) otherwise.
 */
@Component({
  selector: 'app-cursor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #dot class="cursor-dot" aria-hidden="true"></div>
    <div #ring class="cursor-ring" aria-hidden="true"></div>
  `,
})
export class Cursor {
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dot = viewChild.required<ElementRef<HTMLElement>>('dot');
  private readonly ring = viewChild.required<ElementRef<HTMLElement>>('ring');

  constructor() {
    afterNextRender(() => {
      if (!pointerMotionEnabled()) {
        // leave the native cursor; hide our (unused) elements
        this.dot().nativeElement.style.display = 'none';
        this.ring().nativeElement.style.display = 'none';
        return;
      }

      const dot = this.dot().nativeElement;
      const ring = this.ring().nativeElement;
      this.doc.documentElement.classList.add('has-cursor');

      let mx = window.innerWidth / 2;
      let my = window.innerHeight / 2;
      let rx = mx;
      let ry = my;
      let raf = 0;

      const root = this.doc.documentElement;
      const onMove = (e: PointerEvent) => {
        mx = e.clientX;
        my = e.clientY;
        dot.style.transform = `translate(${mx}px, ${my}px) translate(-50%, -50%)`;
        // feed the background spotlight (consumed by .bg-spotlight)
        root.style.setProperty('--mx', `${(mx / window.innerWidth) * 100}%`);
        root.style.setProperty('--my', `${(my / window.innerHeight) * 100}%`);
      };

      // ring eases toward the pointer for a trailing feel
      const loop = () => {
        rx += (mx - rx) * 0.18;
        ry += (my - ry) * 0.18;
        ring.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, -50%) scale(${scale})`;
        raf = requestAnimationFrame(loop);
      };

      let scale = 1;
      const grow = (e: Event) => {
        if ((e.target as HTMLElement).closest('a, button, [data-cursor]')) scale = 1.8;
      };
      const shrink = (e: Event) => {
        if ((e.target as HTMLElement).closest('a, button, [data-cursor]')) scale = 1;
      };

      window.addEventListener('pointermove', onMove, { passive: true });
      this.doc.addEventListener('pointerover', grow, { passive: true });
      this.doc.addEventListener('pointerout', shrink, { passive: true });
      raf = requestAnimationFrame(loop);

      this.destroyRef.onDestroy(() => {
        cancelAnimationFrame(raf);
        window.removeEventListener('pointermove', onMove);
        this.doc.removeEventListener('pointerover', grow);
        this.doc.removeEventListener('pointerout', shrink);
        this.doc.documentElement.classList.remove('has-cursor');
      });
    });
  }
}
