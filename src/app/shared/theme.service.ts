import { DOCUMENT, Injectable, inject, signal } from '@angular/core';

type Theme = 'dark' | 'light';

/**
 * Dark-first theme toggle. Persists to localStorage and reflects the choice as
 * a class on <html>. SSR-safe (guards on document/localStorage availability).
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  readonly theme = signal<Theme>('dark');

  constructor() {
    const stored = this.read();
    if (stored) this.apply(stored);
  }

  toggle(): void {
    this.apply(this.theme() === 'dark' ? 'light' : 'dark');
  }

  private apply(theme: Theme): void {
    this.theme.set(theme);
    const root = this.doc.documentElement;
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
    try {
      this.doc.defaultView?.localStorage?.setItem('theme', theme);
    } catch {
      /* storage unavailable (SSR / privacy mode) — ignore */
    }
  }

  private read(): Theme | null {
    try {
      const v = this.doc.defaultView?.localStorage?.getItem('theme');
      return v === 'light' || v === 'dark' ? v : null;
    } catch {
      return null;
    }
  }
}
