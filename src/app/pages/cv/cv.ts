import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucideBriefcase,
  lucideGraduationCap,
  lucideAward,
  lucideExternalLink,
  lucideMail,
  lucideCalendar,
  lucideUser,
  lucideIdCard,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  PROFILE,
  EXPERIENCE,
  EDUCATION,
  PUBLICATION,
  SKILL_BARS,
  AMCAT_URL,
} from '../../data/profile.data';
import { RevealDirective } from '../../shared/reveal.directive';

@Component({
  selector: 'app-cv',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButtonImports, RevealDirective],
  providers: [
    provideIcons({
      lucideDownload,
      lucideBriefcase,
      lucideGraduationCap,
      lucideAward,
      lucideExternalLink,
      lucideMail,
      lucideCalendar,
      lucideUser,
      lucideIdCard,
    }),
  ],
  templateUrl: './cv.html',
})
export class Cv {
  readonly profile = PROFILE;
  readonly experience = EXPERIENCE;
  readonly education = EDUCATION;
  readonly publication = PUBLICATION;
  readonly skills = SKILL_BARS;
  readonly amcatUrl = AMCAT_URL;

  /** URL of the hosted, professionally-formatted resume PDF. */
  readonly resumeUrl = PROFILE.resumeUrl;
}
