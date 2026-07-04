import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { pointerMotionEnabled } from './env';

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const DENSITY = 1 / 22000; // particles per px² — sparse on purpose
const LINK_DIST = 110; // px — draw a line when two particles are closer
const REPEL_DIST = 120; // px — cursor pushes particles inside this radius
const SPEED = 0.18;

/**
 * Constellation background: slow-drifting particles joined by faint lines,
 * gently repelled by the cursor. Fixed full-viewport canvas behind everything.
 * Desktop + fine-pointer + motion-ok only; renders nothing otherwise (the
 * static dot-grid underneath remains the fallback).
 */
@Component({
  selector: 'app-particles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas
    #canvas
    class="pointer-events-none fixed inset-0 -z-10"
    aria-hidden="true"
  ></canvas>`,
})
export class Particles {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      if (!pointerMotionEnabled()) {
        this.canvasRef().nativeElement.remove();
        return;
      }

      const canvas = this.canvasRef().nativeElement;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      let w = 0;
      let h = 0;
      let particles: P[] = [];
      let mx = -9999;
      let my = -9999;
      let raf = 0;

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        seed();
      };

      const seed = () => {
        const count = Math.round(w * h * DENSITY);
        particles = Array.from({ length: count }, () => ({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * SPEED * 2,
          vy: (Math.random() - 0.5) * SPEED * 2,
        }));
      };

      const step = () => {
        ctx.clearRect(0, 0, w, h);

        for (const p of particles) {
          // cursor repulsion
          const dx = p.x - mx;
          const dy = p.y - my;
          const d2 = dx * dx + dy * dy;
          if (d2 < REPEL_DIST * REPEL_DIST && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const push = ((REPEL_DIST - d) / REPEL_DIST) * 0.6;
            p.x += (dx / d) * push;
            p.y += (dy / d) * push;
          }

          p.x += p.vx;
          p.y += p.vy;
          // wrap around edges
          if (p.x < -10) p.x = w + 10;
          else if (p.x > w + 10) p.x = -10;
          if (p.y < -10) p.y = h + 10;
          else if (p.y > h + 10) p.y = -10;
        }

        // links (n² but n is small — ~80 particles on a 1440×900 viewport)
        for (let i = 0; i < particles.length; i++) {
          const a = particles[i];
          for (let j = i + 1; j < particles.length; j++) {
            const b = particles[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < LINK_DIST * LINK_DIST) {
              const alpha = (1 - Math.sqrt(d2) / LINK_DIST) * 0.14;
              ctx.strokeStyle = `oklch(0.8 0.1 220 / ${alpha.toFixed(3)})`;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
          }
        }

        ctx.fillStyle = 'oklch(0.85 0.06 220 / 0.5)';
        for (const p of particles) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }

        raf = requestAnimationFrame(step);
      };

      const onMove = (e: PointerEvent) => {
        mx = e.clientX;
        my = e.clientY;
      };
      const onLeave = () => {
        mx = -9999;
        my = -9999;
      };
      const onVisibility = () => {
        cancelAnimationFrame(raf);
        if (!document.hidden) raf = requestAnimationFrame(step);
      };

      resize();
      window.addEventListener('resize', resize, { passive: true });
      window.addEventListener('pointermove', onMove, { passive: true });
      document.addEventListener('pointerleave', onLeave, { passive: true });
      document.addEventListener('visibilitychange', onVisibility);
      raf = requestAnimationFrame(step);

      this.destroyRef.onDestroy(() => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerleave', onLeave);
        document.removeEventListener('visibilitychange', onVisibility);
      });
    });
  }
}
