import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideExternalLink,
  lucideGithub,
  lucideFileText,
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
    provideIcons({ lucideArrowLeft, lucideExternalLink, lucideGithub, lucideFileText }),
  ],
  templateUrl: './project-detail.html',
})
export class ProjectDetail {
  /** bound from the route param via withComponentInputBinding() */
  readonly slug = input<string>('');
  readonly project = computed(() => PROJECT_MAP.get(this.slug()) ?? null);
}
