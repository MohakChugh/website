import { RenderMode, ServerRoute } from '@angular/ssr';
import { PROJECTS } from './data/projects.data';
import { BLOG_POSTS } from './data/blog.generated';
import { BLOG_CATEGORIES } from './data/blog-categories';

export const serverRoutes: ServerRoute[] = [
  {
    path: 'projects/:slug',
    renderMode: RenderMode.Prerender,
    getPrerenderParams: async () => PROJECTS.map((p) => ({ slug: p.slug })),
  },
  {
    path: 'blog/:slug',
    renderMode: RenderMode.Prerender,
    getPrerenderParams: async () => BLOG_POSTS.map((p) => ({ slug: p.slug })),
  },
  {
    path: 'topics/:key',
    renderMode: RenderMode.Prerender,
    getPrerenderParams: async () => BLOG_CATEGORIES.map((c) => ({ key: c.key })),
  },
  {
    path: '**',
    renderMode: RenderMode.Prerender,
  },
];
