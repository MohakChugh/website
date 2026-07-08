import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideArrowRight, lucideClock } from '@ng-icons/lucide';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { BlogService } from '../../shared/blog.service';
import { TrustHtmlPipe } from '../../shared/trust-html.pipe';
import { SeoService } from '../../shared/seo.service';
import { RevealDirective } from '../../shared/reveal.directive';
import { CharRevealDirective } from '../../shared/motion/char-reveal.directive';
import { ScrollProgressDirective } from '../../shared/motion/scroll-progress.directive';

@Component({
  selector: 'app-blog-post',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    DatePipe,
    NgIcon,
    HlmBadgeImports,
    TrustHtmlPipe,
    RevealDirective,
    CharRevealDirective,
    ScrollProgressDirective,
  ],
  providers: [provideIcons({ lucideArrowLeft, lucideArrowRight, lucideClock })],
  templateUrl: './blog-post.html',
})
export class BlogPostPage {
  private readonly blog = inject(BlogService);
  private readonly seo = inject(SeoService);

  readonly slug = input<string>('');
  readonly post = computed(() => this.blog.bySlug(this.slug()));
  readonly adjacent = computed(() => this.blog.adjacent(this.slug()));

  readonly related = computed(() => this.blog.related(this.slug()));

  constructor() {
    effect(() => {
      const p = this.post();
      if (!p) return;
      this.seo.apply({
        title: `${p.title} — Mohak Chugh`,
        description: p.excerpt,
        path: `/blog/${p.slug}`,
        type: 'article',
        publishedTime: p.date,
        blogPost: { title: p.title, date: p.date, excerpt: p.excerpt, slug: p.slug, readingMinutes: p.readingMinutes, tags: p.tags },
        faq: p.faq,
      });
    });
  }
}
