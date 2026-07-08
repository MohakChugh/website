import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideClock } from '@ng-icons/lucide';
import { BlogService } from '../../shared/blog.service';
import { SeoService } from '../../shared/seo.service';
import { BLOG_CATEGORIES } from '../../data/blog-categories';
import { RevealDirective } from '../../shared/reveal.directive';
import { TiltDirective } from '../../shared/motion/tilt.directive';

const TOPIC_DESCRIPTIONS: Record<string, string> = {
  'ml-gpu':
    'Deep dives into machine learning systems, GPU programming, LLM inference, attention mechanisms, speculative decoding, vector search, and model optimization. From CUDA kernels to production serving.',
  systems:
    'Systems programming, Linux kernel internals, io_uring, memory management, CPU architecture, SIMD, CXL memory pooling, and datacenter hardware. Performance-critical engineering at the metal.',
  data:
    'Data engineering patterns: lakehouse architectures (Apache Iceberg), cache eviction (SIEVE, LRU), object storage (S3 conditional writes), database internals, file formats, and query engines.',
  distributed:
    'Distributed systems fundamentals: consensus, simulation testing, fault injection, reliability engineering, and coordination primitives for large-scale services.',
  frontend:
    'Frontend engineering with Angular, Tailwind CSS, static site generation, component architectures, and modern web development patterns.',
};

@Component({
  selector: 'app-topic-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, NgIcon, RevealDirective, TiltDirective],
  providers: [provideIcons({ lucideArrowLeft, lucideClock })],
  templateUrl: './topic-hub.html',
})
export class TopicHub {
  private readonly blog = inject(BlogService);
  private readonly seo = inject(SeoService);

  readonly key = input<string>('');

  readonly category = computed(() => BLOG_CATEGORIES.find((c) => c.key === this.key()) ?? null);
  readonly posts = computed(() => this.blog.filterByCategory(this.key()));
  readonly description = computed(() => TOPIC_DESCRIPTIONS[this.key()] ?? '');
  readonly totalMinutes = computed(() => this.blog.totalReadingMinutes(this.posts()));

  constructor() {
    effect(() => {
      const cat = this.category();
      if (!cat) return;
      this.seo.apply({
        title: `${cat.label} — Engineering Notes by Mohak Chugh`,
        description: this.description(),
        path: `/topics/${cat.key}`,
      });
    });
  }
}
