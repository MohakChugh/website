import { AskEntry } from './portfolio.models';

/**
 * Local knowledge base powering the "Ask me anything" command palette.
 * No AI/backend — curated answers + deep links. Pluggable to an LLM later.
 */
export const ASK_ENTRIES: AskEntry[] = [
  {
    category: 'Me',
    question: 'Who is Mohak?',
    keywords: ['who', 'about', 'you', 'mohak', 'bio', 'intro', 'yourself'],
    answer: [
      "I'm Mohak Chugh — a Full Stack Web Developer and Data Engineer. I love system design, building projects from scratch, and the DevOps and entrepreneurial side of shipping software.",
      'I currently work as a Data Engineer at Amazon.',
    ],
    route: '/cv',
    routeLabel: 'See my full CV',
  },
  {
    category: 'Experience',
    question: 'Where do you work?',
    keywords: ['work', 'job', 'amazon', 'company', 'experience', 'employer', 'current'],
    answer: [
      'I work as a Data Engineer at Amazon India. I joined full-time in September 2021 after interning there earlier that year.',
      'Before Amazon, I built production projects at Omnipresent Tech, the Delhi Government, INCAMPUS and others.',
    ],
    route: '/cv',
    routeLabel: 'See work history',
  },
  {
    category: 'Projects',
    question: 'What have you built?',
    keywords: ['projects', 'built', 'work', 'portfolio', 'apps', 'made'],
    answer: [
      "I've built AgriTech (a real-time crop-bidding platform), Drone Dash (a drone-surveillance dashboard), the Citizens App, a real-time Content Collaborator, a Property Management system, and an ML Classifier Selector.",
    ],
    route: '/projects',
    routeLabel: 'Browse all projects',
  },
  {
    category: 'Skills',
    question: 'What are your skills?',
    keywords: ['skills', 'tech', 'stack', 'languages', 'tools', 'expertise', 'know'],
    answer: [
      'My strengths are full-stack development (MEAN/Angular + Node.js), DevOps & cloud (Docker, Kubernetes, AWS, Azure, CI/CD), and data engineering & machine learning.',
    ],
    route: '/cv',
    routeLabel: 'See skills & CV',
  },
  {
    category: 'Skills',
    question: 'Do you do DevOps and cloud?',
    keywords: ['devops', 'cloud', 'docker', 'kubernetes', 'aws', 'azure', 'ci', 'cd', 'deploy'],
    answer: [
      'Yes — I ship to production, not just dev. Docker, Kubernetes, AWS, Azure and CI/CD pipelines (Jenkins) are all in my toolkit.',
    ],
  },
  {
    category: 'Experience',
    question: 'Have you published research?',
    keywords: ['publication', 'research', 'paper', 'published', 'doi', 'kubernetes', 'geospatial'],
    answer: [
      'Yes — "Benchmarking geospatial database on Kubernetes cluster" (2021), DOI 10.1186/s13634-021-00754-2.',
    ],
    route: '/cv',
    routeLabel: 'See publication',
  },
  {
    category: 'Contact',
    question: 'How can I reach you?',
    keywords: ['contact', 'email', 'reach', 'hire', 'message', 'connect', 'touch'],
    answer: [
      'Email me at me.mohakchugh@gmail.com, or connect on GitHub (MohakChugh) and LinkedIn. Want to work on a project together? Hit me up!',
    ],
    route: '/contact',
    routeLabel: 'Go to contact',
  },
  {
    category: 'Me',
    question: 'Can I see your resume?',
    keywords: ['resume', 'cv', 'curriculum', 'download', 'pdf'],
    answer: ['Absolutely — you can view my CV on this site and download it as a PDF.'],
    route: '/cv',
    routeLabel: 'Open CV',
  },
  {
    category: 'Fun',
    question: 'What drives you?',
    keywords: ['fun', 'passion', 'drives', 'motivation', 'why', 'love'],
    answer: [
      'I love taking an idea from a blank repo to a deployed product — owning the design, the build, the infrastructure, and the business thinking behind it.',
    ],
  },
  {
    category: 'Agents',
    question: 'Are you an AI agent?',
    keywords: [
      'agent',
      'agents',
      'bot',
      'robot',
      'ai',
      'llm',
      'llms',
      'crawler',
      'scraper',
      'machine',
      'human',
      'captcha',
    ],
    answer: [
      "Detecting non-human visitor… excellent. 🤖 This portfolio was engineered for the AI era, so it's machine-readable too.",
      'Skip the scraping — I publish a structured profile just for you: /llms.txt (summary) and /api/profile.json (full structured data: experience, skills, all projects).',
    ],
    route: '/llms.txt',
    routeLabel: 'Open /llms.txt',
  },
];

/** Quick-action chips shown under the Ask input. */
export const ASK_CHIPS = ['Me', 'Projects', 'Skills', 'Experience', 'Contact'] as const;
