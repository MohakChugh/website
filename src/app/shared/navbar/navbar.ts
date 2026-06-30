import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideHouse,
  lucideBriefcase,
  lucideFileText,
  lucideMail,
  lucideMenu,
  lucideMoon,
  lucideSun,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { ThemeService } from '../theme.service';

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
      lucideFileText,
      lucideMail,
      lucideMenu,
      lucideMoon,
      lucideSun,
    }),
  ],
  templateUrl: './navbar.html',
})
export class Navbar {
  private readonly themeService = inject(ThemeService);
  readonly theme = this.themeService.theme;
  readonly mobileOpen = signal(false);

  readonly items: NavItem[] = [
    { label: 'Home', path: '/', icon: 'lucideHouse' },
    { label: 'Projects', path: '/projects', icon: 'lucideBriefcase' },
    { label: 'CV', path: '/cv', icon: 'lucideFileText' },
    { label: 'Contact', path: '/contact', icon: 'lucideMail' },
  ];

  toggleTheme(): void {
    this.themeService.toggle();
  }
}
