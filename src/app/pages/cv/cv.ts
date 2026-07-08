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
  PUBLICATIONS,
  SKILL_GROUPS,
  AMCAT_URL,
} from '../../data/profile.data';
import { RevealDirective } from '../../shared/reveal.directive';
import { MagneticDirective } from '../../shared/motion/magnetic.directive';
import { CharRevealDirective } from '../../shared/motion/char-reveal.directive';

@Component({
  selector: 'app-cv',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButtonImports, RevealDirective, MagneticDirective, CharRevealDirective],
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
  readonly publications = PUBLICATIONS;
  readonly skillGroups = SKILL_GROUPS;
  readonly amcatUrl = AMCAT_URL;

  /** URL of the hosted, professionally-formatted resume PDF. */
  readonly resumeUrl = PROFILE.resumeUrl;
}
