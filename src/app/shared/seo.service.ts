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
  /** Blog post JSON-LD data (injected as BlogPosting structured data) */
  blogPost?: { title: string; date: string; excerpt: string; slug: string; readingMinutes: number; tags: string[] };
  /** FAQ items for FAQPage JSON-LD */
  faq?: { question: string; answer: string }[];
}

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

    // BlogPosting JSON-LD
    if (data.blogPost) {
      this.setJsonLd(this.buildBlogPostingLd(data.blogPost, url));
    } else {
      this.removeJsonLd();
    }

    // FAQPage JSON-LD
    if (data.faq?.length) {
      this.setFaqLd(data.faq);
    } else {
      this.removeFaqLd();
    }
  }

  private buildBlogPostingLd(
    p: NonNullable<SeoData['blogPost']>,
    url: string,
  ): object {
    return {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: p.title,
      description: p.excerpt,
      url,
      datePublished: p.date,
      wordCount: p.readingMinutes * 200,
      keywords: p.tags.join(', '),
      author: {
        '@type': 'Person',
        name: 'Mohak Chugh',
        url: SITE_URL,
        jobTitle: 'Software Development Engineer 2',
        worksFor: { '@type': 'Organization', name: 'Amazon' },
      },
      publisher: {
        '@type': 'Person',
        name: 'Mohak Chugh',
        url: SITE_URL,
      },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    };
  }

  private setJsonLd(data: object): void {
    let script = this.doc.head.querySelector<HTMLScriptElement>('script#blog-jsonld');
    if (!script) {
      script = this.doc.createElement('script');
      script.id = 'blog-jsonld';
      script.type = 'application/ld+json';
      this.doc.head.appendChild(script);
    }
    script.textContent = JSON.stringify(data);
  }

  private removeJsonLd(): void {
    this.doc.head.querySelector('script#blog-jsonld')?.remove();
  }

  private setFaqLd(faq: { question: string; answer: string }[]): void {
    let script = this.doc.head.querySelector<HTMLScriptElement>('script#faq-jsonld');
    if (!script) {
      script = this.doc.createElement('script');
      script.id = 'faq-jsonld';
      script.type = 'application/ld+json';
      this.doc.head.appendChild(script);
    }
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    });
  }

  private removeFaqLd(): void {
    this.doc.head.querySelector('script#faq-jsonld')?.remove();
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
