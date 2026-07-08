import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home').then((m) => m.Home),
    data: {
      seo: {
        title: 'Mohak Chugh — SDE 2 @ Amazon · Backend, Data & LLMs',
        description:
          'Mohak Chugh is a Software Development Engineer 2 (SDE 2) at Amazon in Gurugram, working across backend, distributed data systems and LLMs. Full-stack developer and data engineer — see projects, CV and contact.',
        path: '',
      },
    },
  },
  {
    path: 'projects',
    loadComponent: () => import('./pages/projects/projects').then((m) => m.Projects),
    data: {
      seo: {
        title: 'Projects — Mohak Chugh · Amazon SDE 2',
        description:
          'Software projects by Mohak Chugh (Amazon SDE 2): AI/LLM tools, real-time data systems, dashboards and full-stack apps built with Python, Spark, Angular, React and AWS.',
        path: '/projects',
      },
    },
  },
  {
    path: 'projects/:slug',
    loadComponent: () =>
      import('./pages/project-detail/project-detail').then((m) => m.ProjectDetail),
    // SEO for detail pages is set dynamically by the component from the project data.
  },
  {
    path: 'blog',
    loadComponent: () => import('./pages/blog/blog-list').then((m) => m.BlogList),
    data: {
      seo: {
        title: 'Blog — Mohak Chugh · Engineering Notes',
        description:
          'Engineering notes, deep dives, and lessons from building at scale by Mohak Chugh (Amazon SDE 2). Backend, data systems, LLMs, and full-stack development.',
        path: '/blog',
      },
    },
  },
  {
    path: 'blog/:slug',
    loadComponent: () => import('./pages/blog/blog-post').then((m) => m.BlogPostPage),
  },
  {
    path: 'topics/:key',
    loadComponent: () => import('./pages/topics/topic-hub').then((m) => m.TopicHub),
  },
  {
    path: 'cv',
    loadComponent: () => import('./pages/cv/cv').then((m) => m.Cv),
    data: {
      seo: {
        title: 'CV — Mohak Chugh · Software Development Engineer 2 at Amazon, Gurugram',
        description:
          "Mohak Chugh's CV: Software Development Engineer 2 at Amazon (Gurugram, Haryana). Experience in backend engineering, distributed data systems (Spark, Airflow), LLM/RAG on AWS, and full-stack development. Download the PDF résumé.",
        path: '/cv',
      },
    },
  },
  {
    path: 'stats',
    loadComponent: () => import('./pages/stats/stats').then((m) => m.Stats),
    data: {
      seo: {
        title: 'Stats — Mohak Chugh · Live Site Analytics',
        description:
          'Live, real-time analytics for mohakchugh.is-a.dev. Page views, visitors, referrers, devices, and more. Fully transparent, privacy-first, no cookies.',
        path: '/stats',
      },
    },
  },
  {
    path: 'contact',
    loadComponent: () => import('./pages/contact/contact').then((m) => m.Contact),
    data: {
      seo: {
        title: 'Contact — Mohak Chugh · Amazon SDE 2',
        description:
          'Get in touch with Mohak Chugh, Software Development Engineer 2 at Amazon. Email, GitHub and LinkedIn for collaboration, roles and project work.',
        path: '/contact',
      },
    },
  },
  { path: '**', redirectTo: '' },
];
