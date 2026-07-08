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
import { Router, RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowRight, lucideClock, lucideSearch, lucideSparkles, lucideX } from '@ng-icons/lucide';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { BlogService } from '../../shared/blog.service';
import { BlogPost } from '../../data/portfolio.models';
import { RevealDirective } from '../../shared/reveal.directive';
import { TiltDirective } from '../../shared/motion/tilt.directive';
import { ScrollFillDirective } from '../../shared/motion/scroll-fill.directive';

interface DateGroup {
  label: string;
  posts: BlogPost[];
}

@Component({
  selector: 'app-blog-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, NgIcon, HlmBadgeImports, RevealDirective, TiltDirective, ScrollFillDirective],
  providers: [provideIcons({ lucideArrowRight, lucideClock, lucideSearch, lucideSparkles, lucideX })],
  templateUrl: './blog-list.html',
})
export class BlogList {
  private readonly blog = inject(BlogService);
  private readonly router = inject(Router);
  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly searchQuery = signal('');
  readonly activeCategory = signal<string | null>(null);
  readonly activeTag = signal<string | null>(null);
  readonly visibleCount = signal(12);
  readonly focusedIndex = signal(-1);

  readonly categories = computed(() => this.blog.categories());
  readonly totalPosts = computed(() => this.blog.all().length);
  readonly maxReading = computed(() => this.blog.maxReadingMinutes());

  /** Filtered posts: search > tag > category > all */
  readonly filteredPosts = computed(() => {
    const q = this.searchQuery();
    if (q.length >= 2) return this.blog.search(q);
    const tag = this.activeTag();
    if (tag) return this.blog.filterByTag(tag);
    return this.blog.filterByCategory(this.activeCategory());
  });

  readonly totalReadingTime = computed(() => this.blog.totalReadingMinutes(this.filteredPosts()));
  readonly isSearching = computed(() => this.searchQuery().length >= 2);

  /** Featured post (first in filtered list, only when not searching). */
  readonly featured = computed(() => (this.isSearching() ? null : this.filteredPosts()[0] ?? null));

  /** Posts for the grid (skip featured when shown). */
  readonly gridPosts = computed(() => {
    const all = this.filteredPosts();
    return this.isSearching() ? all : all.slice(1);
  });

  /** Visible slice (progressive disclosure). */
  readonly visiblePosts = computed(() => {
    const posts = this.gridPosts();
    return this.isSearching() ? posts : posts.slice(0, this.visibleCount());
  });

  readonly hasMore = computed(() => this.gridPosts().length > this.visibleCount() && !this.isSearching());

  /** Group visible posts by date for the timeline. */
  readonly dateGroups = computed<DateGroup[]>(() => {
    const posts = this.visiblePosts();
    const groups: DateGroup[] = [];
    let currentLabel = '';
    for (const p of posts) {
      const label = new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, posts: [] });
      }
      groups[groups.length - 1].posts.push(p);
    }
    return groups;
  });

  /** Curated sections for discovery (shown when no search/filter active). */
  readonly showDiscovery = computed(() => !this.isSearching() && !this.activeCategory() && !this.activeTag());

  /** Featured picks — manually pinned or longest/most in-depth posts. */
  readonly featuredPicks = computed(() => {
    const posts = this.blog.all();
    return [...posts].sort((a, b) => b.readingMinutes - a.readingMinutes).slice(0, 3);
  });

  /** Deep dives — posts with the highest reading time (most thorough). */
  readonly deepDives = computed(() => {
    const posts = this.blog.all();
    return [...posts].sort((a, b) => b.readingMinutes - a.readingMinutes).slice(0, 4);
  });

  /** Latest — most recent 4 posts. */
  readonly latestPosts = computed(() => this.blog.all().slice(0, 4));

  /** Flat list of all visible posts for keyboard navigation indexing. */
  private readonly flatVisible = computed(() => {
    const feat = this.featured();
    const grid = this.visiblePosts();
    return feat ? [feat, ...grid] : grid;
  });

  onSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
    this.focusedIndex.set(-1);
  }

  clearSearch(): void {
    this.searchQuery.set('');
    this.searchInput()?.nativeElement.focus();
  }

  setCategory(key: string | null): void {
    this.activeCategory.set(key);
    this.activeTag.set(null);
    this.visibleCount.set(12);
    this.focusedIndex.set(-1);
  }

  setTag(tag: string): void {
    this.activeTag.set(tag);
    this.activeCategory.set(null);
    this.visibleCount.set(12);
    this.focusedIndex.set(-1);
  }

  clearTag(): void {
    this.activeTag.set(null);
  }

  showMore(): void {
    this.visibleCount.update((n) => n + 12);
  }

  readingSpectrum(post: BlogPost): number {
    return (post.readingMinutes / this.maxReading()) * 100;
  }

  flatIndexOf(post: BlogPost): number {
    return this.flatVisible().indexOf(post);
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') {
        this.clearSearch();
        (e.target as HTMLElement).blur();
      }
      return;
    }

    const flat = this.flatVisible();
    switch (e.key) {
      case 'j':
        e.preventDefault();
        this.focusedIndex.update((i) => Math.min(i + 1, flat.length - 1));
        break;
      case 'k':
        e.preventDefault();
        this.focusedIndex.update((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        const idx = this.focusedIndex();
        if (idx >= 0 && idx < flat.length) {
          e.preventDefault();
          this.router.navigate(['/blog', flat[idx].slug]);
        }
        break;
      }
      case '/':
        e.preventDefault();
        this.searchInput()?.nativeElement.focus();
        break;
      case 'Escape':
        if (this.activeTag()) this.clearTag();
        else if (this.activeCategory()) this.setCategory(null);
        break;
    }
  }
}
