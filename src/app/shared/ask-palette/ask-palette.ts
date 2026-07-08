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
import { BlogService } from '../blog.service';
import { ASK_CHIPS } from '../../data/ask.data';
import { AskEntry, BlogPost, Project } from '../../data/portfolio.models';
import { ProjectCard } from '../project-card/project-card';

/**
 * "Ask me anything" command palette — the site's signature interaction.
 * Controlled overlay (signal-driven) so ⌘K, the hero input, and quick chips
 * all open the same surface. Answers are served locally (no AI/backend).
 */
@Component({
  selector: 'app-ask-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, ProjectCard],
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
  private readonly blog = inject(BlogService);
  private readonly router = inject(Router);

  readonly open = signal(false);
  readonly query = signal('');
  readonly chips = ASK_CHIPS;

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly results = computed<AskEntry[]>(() => this.ask.search(this.query()));
  /** Real project cards matching the query, shown inline above the answers. */
  readonly projectResults = computed<Project[]>(() => this.ask.searchProjects(this.query()));
  /** Blog posts matching the query (top 5). */
  readonly blogResults = computed<BlogPost[]>(() => this.blog.search(this.query()).slice(0, 5));

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
    if (!entry.route) return;
    this.close();
    // Static files (e.g. /llms.txt) aren't Angular routes — navigate the browser.
    if (entry.route.includes('.')) {
      window.open(entry.route, '_blank', 'noopener');
    } else {
      this.router.navigateByUrl(entry.route);
    }
  }

  /** Navigate to a blog post from the palette. */
  gotoBlog(post: BlogPost): void {
    this.close();
    this.router.navigate(['/blog', post.slug]);
  }

  /** Close the palette when a project card inside it is clicked. */
  closeAfterNav(): void {
    this.close();
  }
}
