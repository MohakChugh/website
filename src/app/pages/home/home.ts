import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';

@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports],
  template: `
    <main class="min-h-screen bg-aurora relative grid place-items-center bg-dotgrid">
      <div class="text-center space-y-6 p-8">
        <p class="eyebrow">FULL-STACK · DATA · ML</p>
        <h1 class="font-display text-6xl md:text-8xl font-bold tracking-tight">
          Hello, I'm <span class="text-gradient">Mohak Chugh</span>
        </h1>
        <p class="text-muted-foreground max-w-xl mx-auto text-lg">
          Pipeline smoke test — Tailwind v4 + spartan-ng + fonts wired.
        </p>
        <button hlmBtn size="lg">Contact me</button>
      </div>
    </main>
  `,
})
export class Home {}
