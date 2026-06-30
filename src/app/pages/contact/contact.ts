import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideGithub,
  lucideLinkedin,
  lucideInstagram,
  lucideMail,
  lucideArrowUpRight,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { PROFILE, SOCIALS } from '../../data/profile.data';
import { RevealDirective } from '../../shared/reveal.directive';

@Component({
  selector: 'app-contact',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButtonImports, RevealDirective],
  providers: [
    provideIcons({ lucideGithub, lucideLinkedin, lucideInstagram, lucideMail, lucideArrowUpRight }),
  ],
  templateUrl: './contact.html',
})
export class Contact {
  readonly profile = PROFILE;
  readonly socials = SOCIALS;
  readonly mailto = `mailto:${PROFILE.email}?subject=Contacting via your website`;
}
