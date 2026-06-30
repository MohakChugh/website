import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  signal,
  inject,
  PLATFORM_ID,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideArrowUpRight,
  lucideGithub,
  lucideMail,
  lucideSparkles,
  lucideCode,
  lucideCloud,
  lucideBrain,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { PROFILE, SKILL_CARDS } from '../../data/profile.data';
import { PROJECTS } from '../../data/projects.data';
import { RevealDirective } from '../../shared/reveal.directive';
import { AskPalette } from '../../shared/ask-palette/ask-palette';
import { ProjectCard } from '../../shared/project-card/project-card';

@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, HlmButtonImports, RevealDirective, AskPalette, ProjectCard],
  providers: [
    provideIcons({
      lucideArrowRight,
      lucideArrowUpRight,
      lucideGithub,
      lucideMail,
      lucideSparkles,
      lucideCode,
      lucideCloud,
      lucideBrain,
    }),
  ],
  templateUrl: './home.html',
})
export class Home implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly profile = PROFILE;
  readonly skills = SKILL_CARDS;
  /** first three projects shown as "featured" on the home page */
  readonly featured = PROJECTS.slice(0, 3);

  /** index into profile.roles for the rotating-role headline word */
  readonly roleIndex = signal(0);

  ngOnInit(): void {
    if (!this.isBrowser) return;
    const id = setInterval(() => {
      this.roleIndex.update((i) => (i + 1) % this.profile.roles.length);
    }, 2200);
    this.destroyRef.onDestroy(() => clearInterval(id));
  }
}
