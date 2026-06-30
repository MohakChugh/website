import { Project } from './portfolio.models';

/** All project content, ported verbatim from the legacy site. */
export const PROJECTS: Project[] = [
  {
    slug: 'agritech',
    title: 'AgriTech — Farmers App',
    tagline:
      'A real-time bidding app with a transparent, open network where anyone can sell their crops at a fair rate.',
    image: 'assets/img/tech/agritech.png',
    kind: 'Full Stack',
    tags: ['Angular', 'Node.js', 'Express', 'MongoDB', 'Docker', 'NLP', 'ML'],
    links: [
      { label: 'Live Demo', url: 'https://farmersapp-microbits.firebaseapp.com/', icon: 'lucideExternalLink' },
      { label: 'GitHub', url: 'https://github.com/mohakchugh/farmersapp', icon: 'lucideGithub' },
      {
        label: 'Presentation',
        url: 'https://docs.google.com/presentation/d/1xDPth2sxfXL4W2G8_0gDD7KL_TM6q0hYhag-hjXBiQY/edit',
        icon: 'lucideFileText',
      },
    ],
    sections: [
      {
        body: [
          'AgriTech aspires to make the process of connecting suppliers and consumers seamless, through an "open and transparent channel" using the ideology of "an everything store for people expecting more" where producers get all the information they need for high profitability and consumers get the best quality produce directly from the farm. Penny-pinching, while you enjoy your fresh veggies!',
        ],
      },
      {
        heading: 'Our role in the Indian market',
        body: [
          'We ensure natural supply-demand by digitizing the process, thereby reducing inflation and reducing the scope of profiteering. Normalised rates are automatically enforced because of the vast variety of supplies from producers. We reduce income disparity between large- and small-scale farmers by providing them the same level playing ground. It is an initiative taken to organise an unorganised sector.',
        ],
      },
      {
        heading: 'Architecture',
        body: [
          'AgriTech uses a 3-tier architecture. The frontend is powered by Angular, providing strong static typing at the client side and robust state management for a seamless user experience. The middle tier is implemented as Dockerized microservices using Express on Node.js, enabling high performance and coordinating with our Python modules for NLP and image processing. The physical tier integrates SQL and NoSQL (MongoDB) databases featuring strong relational mappings, flexibility and a high level of robustness.',
        ],
      },
      {
        heading: 'Quirks and features',
        body: [
          'Producers and consumers register and authenticate into our app or via WhatsApp. Guided by our voice assistant at each step, the producer can update information about their produce, or use "OK Google", WhatsApp and Facebook Messenger for the same on our platform. As soon as produce is posted, it is put up as a bid for buyers on our bidding feed. Real-time bidding takes place and the highest bidder claims the produce. Buyers can use the "Buy Now" feature to bypass bidding and claim the product directly at a fixed price stated by the producer. Once a bid is updated, expired or claimed, the producer and highest bidder are always notified via SMS, WhatsApp and push notifications. When the buyer claims the bid, they pay 15% of the total amount as a refundable token; on completion of delivery, the buyer pays the remaining 85%.',
        ],
      },
    ],
  },
  {
    slug: 'citizens',
    title: 'Citizens App',
    tagline:
      'Reach out to government officials through an open and transparent channel — by tweeting at them, messaging on WhatsApp, or via our web portal.',
    image: 'assets/img/tech/citizens.png',
    kind: 'Full Stack',
    tags: ['Angular', 'Firebase', 'Node.js', 'Social Integration'],
    links: [
      { label: 'Live Demo', url: 'https://citizensapp.firebaseapp.com/', icon: 'lucideExternalLink' },
      { label: 'GitHub', url: 'https://github.com/MohakChugh/Citizensapp', icon: 'lucideGithub' },
      {
        label: 'Presentation',
        url: 'https://docs.google.com/presentation/d/1vr-UgDl6nfJExo42RxD7eqOwlWR6SBeefC36Fz5c7vc/edit',
        icon: 'lucideFileText',
      },
    ],
    sections: [
      {
        heading: 'A smart app for citizen–government collaboration',
        body: [
          'The application enables citizens to report local problems such as potholes, illegal trash dumping, faulty street lights, broken sidewalk tiles, and illegal advertising boards. A digitized platform to report such issues avoids redundant complaints, gives remote areas easier access to government, and ensures streamlined action. To file a complaint, citizens can first check for a similar existing complaint and add their digital signature to amplify the impact of a particular issue.',
        ],
      },
      {
        heading: 'Context',
        body: [
          'A city becomes smarter only when citizens and government work together. In a smart city, every citizen should be able to report local problems effectively, anonymously (if required), via a transparent process that reaches every remote area of the city.',
        ],
      },
    ],
  },
  {
    slug: 'content-collaborator',
    title: 'Content Collaborator',
    tagline:
      'A real-time content editor that lets a group of users collaborate on documents or webpage content, see changes live, and publish in no time.',
    image: 'assets/img/tech/text-editor.jpg',
    video: 'assets/img/tech/text-editor.mp4',
    kind: 'Full Stack',
    tags: ['Angular', 'Node.js', 'MongoDB', 'WebSockets', 'Docker'],
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/Content-Collaborator', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'This is a real-time content editor which allows a group of users to collaborate on documents or webpage contents, see changes in real time, make changes as they go, and upload the content in no time.',
        ],
      },
      {
        heading: 'How real-time collaboration works',
        body: [
          'After the initial login/registration you see the editor. Everyone connected to the server who is logged in can see the editor, make changes to the document, see changes in real time, and then push the HTML created from the editor into the database. When everyone logged in is on the editor page, they are instantly connected to the server and can make changes to the document as they proceed.',
        ],
      },
    ],
  },
  {
    slug: 'property-management',
    title: 'Property Management',
    tagline: 'A highly secure and beautiful property management system, with a strong emphasis on security.',
    image: 'assets/img/tech/pm.png',
    kind: 'Full Stack',
    tags: ['Angular 8', 'Node.js', 'PostgreSQL', 'Hasura GraphQL', 'Heroku', 'Firebase'],
    links: [
      { label: 'Live Demo', url: 'https://mnrproject.firebaseapp.com/', icon: 'lucideExternalLink' },
    ],
    sections: [
      {
        body: ['A highly secure and beautiful property management system, with a high emphasis on security.'],
      },
      {
        heading: 'Stack',
        bullets: [
          'Backend created on Node.js and deployed on Heroku',
          'Database: PostgreSQL with Hasura GraphQL Engine, deployed to Heroku',
          'Frontend built on Angular 8 and deployed on Firebase',
        ],
      },
    ],
  },
  {
    slug: 'drone-dash',
    title: 'Drone Dash',
    tagline:
      'A one-stop dashboard for surveillance using drones — SMS & email integration, report generation, scheduling, messaging, role-based access and more.',
    image: 'assets/img/tech/dronedash.png',
    kind: 'Dashboard',
    tags: ['Angular', 'Node.js', 'PostgreSQL', 'Hasura GraphQL', 'AWS S3'],
    links: [
      { label: 'Live Demo', url: 'http://dashboard.omnipresenttech.com/', icon: 'lucideExternalLink' },
      { label: 'GitHub', url: 'https://github.com/MohakChugh/DroneDash', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'Drone Dash is a dashboard for surveillance using drones. It provides role-based access, reports, instructions to the pilot, flight status, communication between clients and the admin, livestreaming, schedule uploads and much more.',
          'Drone Dash is built using Angular, Node.js, PostgreSQL and Hasura GraphQL Engine, with file uploads on an AWS S3 bucket.',
        ],
      },
      {
        heading: 'Features',
        bullets: [
          'SMS and email integration for notifications',
          'Report validation by admin',
          'Role-based access (admin, semi-admin, client and pilot)',
          'Messaging service',
          'Flight stats and logs, and much more',
        ],
      },
    ],
  },
  {
    slug: 'classifier-selector',
    title: 'Classifier Selector',
    tagline:
      'A machine-learning dashboard for predicting the class of the Iris dataset, with support for multiple classifiers.',
    image: 'assets/img/tech/Dashboard_Demo.jpg',
    video: 'assets/img/tech/Dashboard_Demo.mp4',
    kind: 'Dashboard',
    tags: ['Python', 'Machine Learning', 'Dashboard', 'scikit-learn'],
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/DataDashboards', icon: 'lucideGithub' },
    ],
    sections: [
      {
        heading: 'Machine Learning Classifier Dashboard for the IRIS dataset',
        body: ['A machine-learning dashboard for prediction of the class of the Iris dataset.'],
        bullets: [
          'K Nearest Neighbours',
          'Logistic Regression',
          'Decision Tree Classifier',
          'Random Forest',
          'Support Vector Machine',
        ],
      },
      {
        heading: 'Features',
        bullets: [
          'Prediction',
          'Comparison between multiple classifiers',
          'Trends and dataset view',
          'See the accuracy directly while selecting the classifier',
        ],
      },
    ],
  },
  {
    slug: 'bridge',
    title: 'Bridge — Control AI from Anywhere',
    tagline:
      'Drive your AI coding agents from a web dashboard, iMessage, or Slack — with a visual workflow builder, parallel execution, and scheduled automations.',
    image: 'assets/img/tech/bridge.png',
    kind: 'AI Tooling',
    tags: ['Python', 'FastAPI', 'React', 'TypeScript', 'React Flow', 'Slack API', 'WebSocket'],
    placeholderIcon: 'lucideWorkflow',
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/bridge', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'Bridge is a Python daemon that lets you drive AI coding CLIs — Claude Code, Wasabi, and Kiro CLI — from wherever you are: a local web dashboard, iMessage on an Apple device, or a Slack DM. A FastAPI gateway exposes REST and WebSocket endpoints, coordinated by a SessionManager, WorkflowEngine, and EventBus, with persistent cross-session memory that keeps context across conversations.',
        ],
        bullets: [
          'Multi-channel control: web dashboard, iMessage, and Slack (Socket Mode)',
          'Persistent cross-session memory',
          'Parallel execution of up to 4 concurrent AI sessions',
          'Watch mode, scheduled tasks, and natural-language reminders',
        ],
      },
      {
        heading: 'Visual workflow builder',
        body: [
          'A drag-and-drop canvas built on React Flow lets you compose AI workflows from eight node types and run them on an Airflow-style operations dashboard with full run history.',
        ],
        bullets: [
          'Eight node types: Start, Prompt, Branch, Merge, Delay, Approval, Notify, End',
          'Airflow-style operations dashboard with run history',
          'Conditional and parallel branching',
        ],
      },
    ],
  },
  {
    slug: 'recruiter-automation',
    title: 'Recruiter Automation',
    tagline:
      'A free, browser-based tool that uses AI to rank resumes and analyze candidates — processing up to 1,000 files entirely offline, with no backend or API keys.',
    kind: 'AI Tooling',
    tags: ['React', 'TypeScript', 'Vite', 'Tailwind CSS', 'IndexedDB', 'pdf.js', 'PWA'],
    placeholderIcon: 'lucideUsers',
    links: [
      {
        label: 'Live Demo',
        url: 'https://mohakchugh.github.io/recruiter-automation/',
        icon: 'lucideExternalLink',
      },
      {
        label: 'GitHub',
        url: 'https://github.com/MohakChugh/recruiter-automation',
        icon: 'lucideGithub',
      },
    ],
    sections: [
      {
        body: [
          'Recruiter Automation is a fully client-side recruiting tool that streamlines candidate screening directly in the browser. Recruiters can bulk-upload up to 1,000 PDF or DOCX resumes, after which the app automatically extracts skills, location, and years of experience from each document. It is completely free, requiring no backend, API keys, or subscriptions.',
        ],
        bullets: [
          'Bulk upload of up to 1,000 PDF/DOCX resumes',
          'Automatic extraction of skills, location, and experience',
          'Two-tier scoring: rule-based ranking plus AI reasoning',
          'Natural-language chat to query the candidate pool',
          'Installable PWA that works fully offline',
        ],
      },
      {
        heading: 'Architecture & privacy',
        body: [
          'Built as an installable Progressive Web App, the tool runs offline and keeps all candidate data local in IndexedDB (via Dexie.js), so no resume data ever leaves the user’s machine. Heavy parsing is offloaded to Web Workers using pdf.js and mammoth.js to keep the UI responsive. The frontend is a Vite-powered React 18 + TypeScript stack styled with shadcn/ui and Tailwind CSS.',
        ],
      },
    ],
  },
  {
    slug: 'dev-vibes',
    title: 'Dev Vibes',
    tagline:
      'A fast, all-in-one developer toolbox bringing formatters, encoders, converters, and generators together in one clean, offline-friendly web app.',
    kind: 'Developer Tool',
    tags: ['Astro', 'React 19', 'TypeScript', 'Tailwind CSS 4', 'Radix UI', 'Vitest', 'Playwright'],
    placeholderIcon: 'lucideWrench',
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/dev-vibes', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'Dev Vibes consolidates the everyday tools engineers reach for — formatters, encoders, converters, and generators — into a single fast, well-organized interface. It is built as a static Astro site with React 19 islands for interactivity, styled with Tailwind CSS 4 and Radix UI / shadcn components, with tools grouped into twelve categories spanning data, formatting, encoding, math, networking, text, units, and media.',
        ],
      },
      {
        heading: 'Capabilities',
        bullets: [
          'Formatters: JSON, SQL, XML, GraphQL, YAML, CSV, and Markdown tables',
          'Encoding & crypto: Base64/Base32, Base58, hashing, URL/punycode, UUID',
          'Helpers: cron expression explanations, KaTeX math rendering, user-agent parsing',
          'Polished UX: command palette, light/dark theming, toast notifications',
          'Quality-focused: Vitest unit tests and Playwright end-to-end coverage',
        ],
      },
    ],
  },
  {
    slug: 'imessage-claude-bridge',
    title: 'iMessage → Claude Bridge',
    tagline:
      'Control Claude Code from your iPhone via iMessage — text yourself prompts, get responses back, with persistent sessions, task queuing, and directory switching.',
    image: 'assets/img/tech/bridge-workflow.png',
    kind: 'AI Tooling',
    tags: ['Python', 'FastAPI', 'AppleScript', 'WebSocket', 'macOS', 'launchd'],
    placeholderIcon: 'lucideSmartphone',
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/bridge', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'The project that grew into Bridge: an iMessage-to-Claude control plane that lets you operate Claude Code straight from your phone. You text yourself a prompt and get the response back, with persistent sessions, task queuing, and on-the-fly working-directory switching — all without opening a laptop.',
        ],
        bullets: [
          'Control Claude Code from your iPhone via iMessage',
          'Persistent sessions with task queuing',
          'Switch working directories on the fly from your phone',
          'Live streaming responses back to the chat',
        ],
      },
      {
        heading: 'Evolution',
        body: [
          'Originally built as a focused iMessage bridge, it evolved into a unified, multi-channel daemon (now Bridge) that shares the same session state across iMessage, Slack, and a web dashboard, backed by launchd auto-start, crash recovery, and atomic state writes.',
        ],
      },
    ],
  },
  {
    slug: 'fit-strong-90',
    title: 'FitStrong 90',
    tagline:
      'A 90-day fitness transformation tracker that guides you through a structured 3-phase program with per-set logging, progress charts, and full offline support.',
    kind: 'Fitness',
    tags: ['React', 'TypeScript', 'Vite', 'Tailwind CSS', 'shadcn/ui', 'Recharts'],
    placeholderIcon: 'lucideDumbbell',
    links: [
      {
        label: 'Live Demo',
        url: 'https://mohakchugh.github.io/fit-strong-90/',
        icon: 'lucideExternalLink',
      },
      { label: 'GitHub', url: 'https://github.com/MohakChugh/fit-strong-90', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'FitStrong 90 structures a complete 90-day transformation into three progressive phases — Foundation, Hypertrophy, and Strength — built around a 6-day training split. Every workout is tracked at the set level with weight, reps, and RPE, and all data lives in the browser via localStorage, so the app works fully offline with no account or backend.',
        ],
        bullets: [
          '90-day program across 3 progressive phases',
          '6-day split with per-set weight, reps, and RPE tracking',
          'Built-in rest timer and exercise library with demos',
          'Progress charts for volume, bodyweight, and personal records',
          'Workout history calendar and JSON export/import',
        ],
      },
    ],
  },
  {
    slug: 'connectus',
    title: 'ConnectUs',
    tagline:
      'A frontend-only, end-to-end encrypted video calling app with no custom backend — using WebRTC and application-layer frame encryption over an untrusted relay.',
    kind: 'Web App',
    tags: ['React', 'TypeScript', 'Material UI', 'Vite', 'WebRTC', 'Web Crypto API'],
    placeholderIcon: 'lucideShieldCheck',
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/connectus', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'ConnectUs is a zero-backend, end-to-end encrypted video call application deployed as a static site. There is no database, no analytics, and no trackers — signaling rides over an untrusted public WebSocket relay that only ever sees encrypted payloads. The room key lives only in the URL hash fragment and is never transmitted to any server.',
        ],
        bullets: [
          'End-to-end encrypted signaling (AES-GCM-256) over an untrusted relay',
          'Application-layer media frame encryption via WebRTC Insertable Streams',
          'Signal-style safety-number verification for peer identity',
          'Two-party room enforcement and replay protection',
          'No backend, no database, no analytics, no trackers',
        ],
      },
    ],
  },
  {
    slug: 'flashread',
    title: 'FlashRead',
    tagline:
      'A minimalist RSVP speed-reading tool that flashes text one word at a time with optimal-recognition-point highlighting — to read at the speed of thought.',
    kind: 'Productivity',
    tags: ['JavaScript', 'HTML', 'CSS', 'Web Speech API', 'localStorage'],
    placeholderIcon: 'lucideBookOpen',
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/FLASHREAD', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'FlashRead is a single-page RSVP speed-reading tool — paste in an article or chapter and it flashes words one at a time at a configurable pace, using an Optimal Recognition Point (ORP) highlight to keep your eyes fixed at the center of each word. It is a self-contained, framework-free web app, with settings that persist between sessions.',
        ],
        bullets: [
          'Adjustable reading speed (100–1000 WPM) and font size',
          'ORP word highlighting with previous/next preview and sentence context',
          '“Start from word” input, progress bar, and time-remaining estimate',
          'Optional voice narration via the Web Speech API',
          'Full keyboard shortcuts and a completion summary (words, time, avg WPM)',
        ],
      },
    ],
  },
];

export const PROJECT_MAP = new Map(PROJECTS.map((p) => [p.slug, p]));
