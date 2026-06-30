import { RenderMode, ServerRoute } from '@angular/ssr';
import { PROJECTS } from './data/projects.data';

export const serverRoutes: ServerRoute[] = [
  {
    path: 'projects/:slug',
    renderMode: RenderMode.Prerender,
    // Prerender one static page per project at build time (SSG).
    getPrerenderParams: async () => PROJECTS.map((p) => ({ slug: p.slug })),
  },
  {
    path: '**',
    renderMode: RenderMode.Prerender,
  },
];
