import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideCornerDownLeft,
  lucideSearch,
  lucideSparkles,
  lucideX,
} from '@ng-icons/lucide';
import { AskService } from '../ask.service';
import { ASK_CHIPS } from '../../data/ask.data';
import { AskEntry } from '../../data/portfolio.models';

/**
 * "Ask me anything" command palette — the site's signature interaction.
 * Controlled overlay (signal-driven) so ⌘K, the hero input, and quick chips
 * all open the same surface. Answers are served locally (no AI/backend).
 */
@Component({
  selector: 'app-ask-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  providers: [
    provideIcons({
      lucideSearch,
      lucideSparkles,
      lucideArrowRight,
      lucideCornerDownLeft,
      lucideX,
    }),
  ],
  templateUrl: './ask-palette.html',
})
export class AskPalette {
  private readonly ask = inject(AskService);
  private readonly router = inject(Router);

  readonly open = signal(false);
  readonly query = signal('');
  readonly chips = ASK_CHIPS;

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly results = computed<AskEntry[]>(() => this.ask.search(this.query()));

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.toggle();
    } else if (e.key === 'Escape' && this.open()) {
      this.close();
    }
  }

  openWith(seed = ''): void {
    this.query.set(seed);
    this.open.set(true);
    queueMicrotask(() => this.input()?.nativeElement.focus());
  }

  toggle(): void {
    this.open() ? this.close() : this.openWith();
  }

  close(): void {
    this.open.set(false);
  }

  onChip(chip: string): void {
    this.query.set(chip);
    this.input()?.nativeElement.focus();
  }

  goto(entry: AskEntry): void {
    if (entry.route) {
      this.close();
      this.router.navigateByUrl(entry.route);
    }
  }
}
