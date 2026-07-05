import { inject, Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Bypasses Angular's HTML sanitizer for pre-rendered blog content.
 * SAFE because the HTML is generated at build time from the repo owner's own
 * markdown files (never user input). The generator is the security boundary.
 */
@Pipe({ name: 'trustHtml', pure: true })
export class TrustHtmlPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(value: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(value);
  }
}
