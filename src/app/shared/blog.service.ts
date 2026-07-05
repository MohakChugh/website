import { Injectable } from '@angular/core';
import { BlogPost } from '../data/portfolio.models';
import { BLOG_POSTS } from '../data/blog.generated';

/**
 * Blog data access — pure, synchronous, unit-tested.
 * Queries the build-time-generated BLOG_POSTS array.
 */
@Injectable({ providedIn: 'root' })
export class BlogService {
  private readonly posts = BLOG_POSTS;

  /** All posts, newest first (the generated array is already date-desc). */
  all(): BlogPost[] {
    return this.posts;
  }

  /** Single post by slug, or null. */
  bySlug(slug: string): BlogPost | null {
    return this.posts.find((p) => p.slug === slug) ?? null;
  }

  /** All distinct tags with their post count, sorted by count desc. */
  tags(): { tag: string; count: number }[] {
    const map = new Map<string, number>();
    for (const p of this.posts) {
      for (const t of p.tags) map.set(t, (map.get(t) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Filter posts by tag (null = all). */
  filterByTag(tag: string | null): BlogPost[] {
    if (!tag) return this.posts;
    return this.posts.filter((p) => p.tags.includes(tag));
  }

  /** Previous and next posts relative to a slug (for prev/next nav). */
  adjacent(slug: string): { prev: BlogPost | null; next: BlogPost | null } {
    const idx = this.posts.findIndex((p) => p.slug === slug);
    if (idx === -1) return { prev: null, next: null };
    return {
      prev: this.posts[idx + 1] ?? null,
      next: this.posts[idx - 1] ?? null,
    };
  }

  /** Keyword search over title/tags/excerpt — same tokenizer as AskService. */
  search(query: string): BlogPost[] {
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];
    return this.posts
      .map((p) => {
        const title = p.title.toLowerCase();
        const tags = p.tags.join(' ').toLowerCase();
        const excerpt = p.excerpt.toLowerCase();
        let score = 0;
        for (const t of tokens) {
          if (tags.includes(t)) score += 4;
          if (title.includes(t)) score += 3;
          if (excerpt.includes(t)) score += 1;
        }
        return { p, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.p);
  }
}
