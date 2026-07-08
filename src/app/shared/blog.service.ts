import { Injectable } from '@angular/core';
import { BlogPost } from '../data/portfolio.models';
import { BLOG_POSTS } from '../data/blog.generated';
import { BLOG_CATEGORIES, BlogCategory, TAG_TO_CATEGORY } from '../data/blog-categories';

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

  /** Categories with post counts (used by the category pill bar). */
  categories(): (BlogCategory & { count: number })[] {
    return BLOG_CATEGORIES.map((c) => ({
      ...c,
      count: this.posts.filter((p) => p.tags.some((t) => c.tags.includes(t))).length,
    })).filter((c) => c.count > 0);
  }

  /** Filter posts by category key (null = all). */
  filterByCategory(categoryKey: string | null): BlogPost[] {
    if (!categoryKey) return this.posts;
    const cat = BLOG_CATEGORIES.find((c) => c.key === categoryKey);
    if (!cat) return this.posts;
    return this.posts.filter((p) => p.tags.some((t) => cat.tags.includes(t)));
  }

  /** Related posts by shared-tag overlap (excludes the source post). */
  related(slug: string, limit = 3): BlogPost[] {
    const source = this.bySlug(slug);
    if (!source) return [];
    return this.posts
      .filter((p) => p.slug !== slug)
      .map((p) => ({ p, score: p.tags.filter((t) => source.tags.includes(t)).length }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.p);
  }

  /** Get the category key for a post (from its first matching tag). */
  categoryOf(post: BlogPost): string | null {
    for (const t of post.tags) {
      const key = TAG_TO_CATEGORY.get(t);
      if (key) return key;
    }
    return null;
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

  /** Total reading minutes across all posts (or a filtered subset). */
  totalReadingMinutes(posts?: BlogPost[]): number {
    return (posts ?? this.posts).reduce((sum, p) => sum + p.readingMinutes, 0);
  }

  /** Max reading time across all posts (for spectrum bar normalization). */
  maxReadingMinutes(): number {
    return Math.max(...this.posts.map((p) => p.readingMinutes), 1);
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
