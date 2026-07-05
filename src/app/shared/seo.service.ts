import { DOCUMENT, inject, Injectable } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';

/** Absolute site origin. Kept in one place so the domain cutover only edits here. */
export const SITE_URL = 'https://mohakchugh.is-a.dev';

export interface SeoData {
  title: string;
  description: string;
  /** path relative to SITE_URL, e.g. '/cv' or '' for home */
  path: string;
  /** Set to 'article' for blog posts (emits og:type=article + published_time) */
  type?: 'website' | 'article';
  /** ISO date for article:published_time (blog posts only) */
  publishedTime?: string;
}

/**
 * Sets per-page SEO tags (title, description, canonical, Open Graph/Twitter URL
 * + title + description). Called on every navigation AND during SSG prerender,
 * so each prerendered HTML file ships unique, keyword-rich metadata.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly doc = inject(DOCUMENT);

  apply(data: SeoData): void {
    const url = `${SITE_URL}${data.path}`;

    this.title.setTitle(data.title);
    this.meta.updateTag({ name: 'description', content: data.description });

    // Open Graph
    this.meta.updateTag({ property: 'og:type', content: data.type ?? 'website' });
    this.meta.updateTag({ property: 'og:title', content: data.title });
    this.meta.updateTag({ property: 'og:description', content: data.description });
    this.meta.updateTag({ property: 'og:url', content: url });

    // article-specific OG tags (blog posts)
    if (data.type === 'article' && data.publishedTime) {
      this.meta.updateTag({ property: 'article:published_time', content: data.publishedTime });
      this.meta.updateTag({ property: 'article:author', content: 'Mohak Chugh' });
    }

    // Twitter
    this.meta.updateTag({ name: 'twitter:title', content: data.title });
    this.meta.updateTag({ name: 'twitter:description', content: data.description });

    this.setCanonical(url);
  }

  private setCanonical(url: string): void {
    let link = this.doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.doc.createElement('link');
      link.setAttribute('rel', 'canonical');
      this.doc.head.appendChild(link);
    }
    link.setAttribute('href', url);
  }
}
