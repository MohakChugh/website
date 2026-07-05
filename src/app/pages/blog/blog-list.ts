import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowRight, lucideClock, lucideSparkles } from '@ng-icons/lucide';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { BlogService } from '../../shared/blog.service';
import { RevealDirective } from '../../shared/reveal.directive';
import { TiltDirective } from '../../shared/motion/tilt.directive';
import { ScrollFillDirective } from '../../shared/motion/scroll-fill.directive';

@Component({
  selector: 'app-blog-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, NgIcon, HlmBadgeImports, RevealDirective, TiltDirective, ScrollFillDirective],
  providers: [provideIcons({ lucideArrowRight, lucideClock, lucideSparkles })],
  templateUrl: './blog-list.html',
})
export class BlogList {
  private readonly blog = inject(BlogService);

  readonly activeTag = signal<string | null>(null);
  readonly allTags = computed(() => this.blog.tags());
  readonly posts = computed(() => this.blog.filterByTag(this.activeTag()));
  readonly featured = computed(() => this.posts()[0] ?? null);
  readonly remaining = computed(() => this.posts().slice(1));

  setTag(tag: string | null): void {
    this.activeTag.set(tag);
  }
}
