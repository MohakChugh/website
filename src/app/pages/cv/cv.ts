import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
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

  readonly generating = signal(false);
  private readonly cvContent = viewChild<ElementRef<HTMLElement>>('cvContent');

  async downloadPdf(): Promise<void> {
    const el = this.cvContent()?.nativeElement;
    if (!el) return;
    this.generating.set(true);
    try {
      // Lazy-load html2pdf only in the browser when actually needed (keeps it
      // out of the main bundle and out of SSR).
      const html2pdf = (await import('html2pdf.js')).default;
      await html2pdf()
        .from(el)
        .set({
          margin: 8,
          filename: 'mohakchugh_cv.pdf',
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, backgroundColor: '#0a0a0a', useCORS: true },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        })
        .save();
    } finally {
      this.generating.set(false);
    }
  }
}
