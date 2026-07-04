import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';
import { Navbar } from './shared/navbar/navbar';
import { Footer } from './shared/footer/footer';
import { Cursor } from './shared/motion/cursor';
import { Particles } from './shared/motion/particles';
import { SeoData, SeoService } from './shared/seo.service';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, Navbar, Footer, Cursor, Particles],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly seo = inject(SeoService);

  constructor() {
    // Apply per-route SEO from route `data.seo` on every navigation (and prerender).
    // Routes that set SEO dynamically (project detail) carry no data.seo and are skipped here.
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      let r = this.route;
      while (r.firstChild) r = r.firstChild;
      const seo = r.snapshot.data['seo'] as SeoData | undefined;
      if (seo) this.seo.apply(seo);
    });
  }
}
