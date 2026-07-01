import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SeoService } from '../../shared/seo.service';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideExternalLink,
  lucideGithub,
  lucideFileText,
  lucideWorkflow,
  lucideUsers,
  lucideWrench,
  lucideSmartphone,
  lucideDumbbell,
  lucideShieldCheck,
  lucideBookOpen,
  lucideCode,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { PROJECT_MAP } from '../../data/projects.data';
import { RevealDirective } from '../../shared/reveal.directive';

@Component({
  selector: 'app-project-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, HlmButtonImports, HlmBadgeImports, RevealDirective],
  providers: [
    provideIcons({
      lucideArrowLeft,
      lucideExternalLink,
      lucideGithub,
      lucideFileText,
      lucideWorkflow,
      lucideUsers,
      lucideWrench,
      lucideSmartphone,
      lucideDumbbell,
      lucideShieldCheck,
      lucideBookOpen,
      lucideCode,
    }),
  ],
  templateUrl: './project-detail.html',
})
export class ProjectDetail {
  private readonly seo = inject(SeoService);

  /** bound from the route param via withComponentInputBinding() */
  readonly slug = input<string>('');
  readonly project = computed(() => PROJECT_MAP.get(this.slug()) ?? null);

  constructor() {
    // Set keyword-rich, per-project SEO (runs on navigation and during prerender).
    effect(() => {
      const p = this.project();
      if (!p) return;
      this.seo.apply({
        title: `${p.title} — Mohak Chugh`,
        description: `${p.tagline} A ${p.kind.toLowerCase()} project by Mohak Chugh (Amazon SDE 2). Built with ${p.tags.slice(0, 4).join(', ')}.`,
        path: `/projects/${p.slug}`,
      });
    });
  }
}

