import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUpRight } from '@ng-icons/lucide';
import { Project } from '../../data/portfolio.models';

/** Reusable project card with image, tech badges, hover lift + glow. */
@Component({
  selector: 'app-project-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon],
  providers: [provideIcons({ lucideArrowUpRight })],
  template: `
    <a
      [routerLink]="['/projects', project().slug]"
      class="group relative block overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/5"
    >
      <!-- gradient glow on hover -->
      <div
        class="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/0 to-primary/0 opacity-0 transition-opacity duration-300 group-hover:from-primary/10 group-hover:to-transparent group-hover:opacity-100"
      ></div>

      <div class="aspect-video overflow-hidden bg-secondary">
        <img
          [src]="project().image"
          [alt]="project().title"
          loading="lazy"
          decoding="async"
          class="size-full object-cover object-top transition-transform duration-500 group-hover:scale-105"
        />
      </div>

      <div class="p-5">
        <div class="flex items-start justify-between gap-2">
          <div>
            <span class="eyebrow">{{ project().kind }}</span>
            <h3 class="mt-1 font-display text-lg font-semibold tracking-tight">
              {{ project().title }}
            </h3>
          </div>
          <ng-icon
            name="lucideArrowUpRight"
            class="size-5 shrink-0 text-muted-foreground transition-all duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary"
          />
        </div>

        <p class="mt-2 line-clamp-2 text-sm text-muted-foreground">{{ project().tagline }}</p>

        <div class="mt-4 flex flex-wrap gap-1.5">
          @for (tag of project().tags.slice(0, 4); track tag) {
            <span
              class="rounded-md bg-secondary px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {{ tag }}
            </span>
          }
        </div>
      </div>
    </a>
  `,
})
export class ProjectCard {
  readonly project = input.required<Project>();
}
