import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGithub, lucideLinkedin, lucideMail } from '@ng-icons/lucide';
import { SOCIALS, PROFILE } from '../../data/profile.data';

@Component({
  selector: 'app-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon],
  providers: [provideIcons({ lucideGithub, lucideLinkedin, lucideMail })],
  templateUrl: './footer.html',
})
export class Footer {
  readonly profile = PROFILE;
  readonly year = 2026;
  readonly links = [
    { label: 'Home', path: '/' },
    { label: 'Projects', path: '/projects' },
    { label: 'Blog', path: '/blog' },
    { label: 'CV', path: '/cv' },
    { label: 'Contact', path: '/contact' },
  ];
  readonly socials = [
    { icon: 'lucideGithub', url: 'https://github.com/MohakChugh', label: 'GitHub' },
    {
      icon: 'lucideLinkedin',
      url: 'https://www.linkedin.com/in/mohakchugh/',
      label: 'LinkedIn',
    },
    { icon: 'lucideMail', url: 'mailto:' + PROFILE.email, label: 'Email' },
  ];
}
