import { describe, expect, it, beforeEach } from 'vitest';
import { BlogService } from './blog.service';

describe('BlogService', () => {
  let service: BlogService;

  beforeEach(() => {
    service = new BlogService();
  });

  it('all() returns posts sorted date-descending', () => {
    const posts = service.all();
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i - 1].date >= posts[i].date).toBe(true);
    }
  });

  it('bySlug returns the correct post', () => {
    const all = service.all();
    if (all.length === 0) return; // no posts yet
    const first = all[0];
    expect(service.bySlug(first.slug)).toEqual(first);
  });

  it('bySlug returns null for unknown slug', () => {
    expect(service.bySlug('nonexistent-slug-xyz')).toBeNull();
  });

  it('tags() returns distinct tags with counts', () => {
    const tags = service.tags();
    const seen = new Set<string>();
    for (const { tag } of tags) {
      expect(seen.has(tag)).toBe(false);
      seen.add(tag);
    }
  });

  it('filterByTag(null) returns all posts', () => {
    expect(service.filterByTag(null)).toEqual(service.all());
  });

  it('filterByTag with a real tag filters correctly', () => {
    const tags = service.tags();
    if (tags.length === 0) return;
    const first = tags[0].tag;
    const filtered = service.filterByTag(first);
    expect(filtered.every((p) => p.tags.includes(first))).toBe(true);
  });

  it('adjacent at the first post has no next', () => {
    const all = service.all();
    if (all.length === 0) return;
    const { next } = service.adjacent(all[0].slug);
    expect(next).toBeNull();
  });

  it('search returns results for known terms', () => {
    const all = service.all();
    if (all.length === 0) return;
    const word = all[0].title.split(' ')[0];
    expect(service.search(word).length).toBeGreaterThan(0);
  });

  it('search returns empty for gibberish', () => {
    expect(service.search('zzzqqq xyzzy').length).toBe(0);
  });
});
