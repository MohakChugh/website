import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home').then((m) => m.Home),
    title: 'Mohak Chugh — Full Stack Developer & Data Engineer',
  },
  {
    path: 'projects',
    loadComponent: () => import('./pages/projects/projects').then((m) => m.Projects),
    title: 'Projects — Mohak Chugh',
  },
  {
    path: 'projects/:slug',
    loadComponent: () =>
      import('./pages/project-detail/project-detail').then((m) => m.ProjectDetail),
    title: 'Project — Mohak Chugh',
  },
  {
    path: 'cv',
    loadComponent: () => import('./pages/cv/cv').then((m) => m.Cv),
    title: 'CV — Mohak Chugh',
  },
  {
    path: 'contact',
    loadComponent: () => import('./pages/contact/contact').then((m) => m.Contact),
    title: 'Contact — Mohak Chugh',
  },
  { path: '**', redirectTo: '' },
];
