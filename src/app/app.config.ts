import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideRouter,
  withViewTransitions,
  withInMemoryScrolling,
  withComponentInputBinding,
} from '@angular/router';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      // Path-based routing keeps the SSG-prerendered HTML per route (best first
      // paint + SEO). On GitHub Pages, deep links are handled by a 404.html that
      // mirrors index.html (the SPA fallback), generated in build:ghpages.
      withViewTransitions(),
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
    ),
    provideClientHydration(withEventReplay()),
    provideHttpClient(withFetch()),
  ],
};
