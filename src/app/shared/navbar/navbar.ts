import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideHouse,
  lucideBriefcase,
  lucideNotebookPen,
  lucideFileText,
  lucideMail,
  lucideMenu,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';

interface NavItem {
  label: string;
  path: string;
  icon: string;
}

@Component({
  selector: 'app-navbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, NgIcon, HlmButtonImports, HlmSheetImports],
  providers: [
    provideIcons({
      lucideHouse,
      lucideBriefcase,
      lucideNotebookPen,
      lucideFileText,
      lucideMail,
      lucideMenu,
    }),
  ],
  templateUrl: './navbar.html',
})
export class Navbar {
  readonly items: NavItem[] = [
    { label: 'Home', path: '/', icon: 'lucideHouse' },
    { label: 'Projects', path: '/projects', icon: 'lucideBriefcase' },
    { label: 'Blog', path: '/blog', icon: 'lucideNotebookPen' },
    { label: 'CV', path: '/cv', icon: 'lucideFileText' },
    { label: 'Contact', path: '/contact', icon: 'lucideMail' },
  ];
}
