import {
  EducationItem,
  ExperienceItem,
  Publication,
  SkillBar,
  SkillCard,
  SocialLink,
} from './portfolio.models';

export const PROFILE = {
  name: 'Mohak Chugh',
  roles: ['Full Stack Developer', 'Data Engineer', 'System Designer', 'Builder'],
  tagline: 'FULL-STACK · DATA · ML',
  location: 'India',
  email: 'me.mohakchugh@gmail.com',
  resumeUrl: 'https://bit.ly/mohakchughcv',
  githubUrl: 'https://github.com/MohakChugh',
  intro:
    "I'm a computer science graduate, Full Stack Web Developer and Data Engineer. I have a passion for system design, building projects from scratch, and working on the DevOps and entrepreneurial side of projects.",
  about:
    'I love building projects end to end — from how the frontend talks to the backend, to how the backend is structured, to deploying it at scale. I currently work as a Data Engineer at Amazon.',
  dob: '17/07/1999',
};

export const SKILL_CARDS: SkillCard[] = [
  {
    title: 'Full Stack Development',
    icon: 'lucideCode',
    body: 'I love building projects from scratch — designing how the frontend talks to the backend, how the backend is structured, and how the finished product looks and feels.',
  },
  {
    title: 'DevOps & Cloud Deployments',
    icon: 'lucideCloud',
    body: 'My projects are not limited to dev environments — they ship to production. Docker? Kubernetes? AWS or Azure? You have got someone who can handle it all.',
  },
  {
    title: 'Data Engineering & ML',
    icon: 'lucideBrain',
    body: 'I love working on the business side too. I build data-driven projects and use that data in machine-learning models to automate the decision-making process.',
  },
];

export const SKILL_BARS: SkillBar[] = [
  { label: 'MEAN Stack', level: 100 },
  { label: 'DevOps', level: 90 },
  { label: 'Soft Skills', level: 85 },
];

/** Work experience & achievements, ported verbatim from the legacy CV. */
export const EXPERIENCE: ExperienceItem[] = [
  {
    role: 'Data Engineer',
    org: 'Amazon India',
    body: 'I interned at Amazon India as a Data Engineer Intern from 15 February 2021 to 15 August 2021, and joined Amazon full-time as a Data Engineer from 6 September 2021.',
  },
  {
    role: 'Mentor',
    org: 'Girlscript Ireland',
    body: 'I was the mentor for the 4-week Gaming Booster program by Girlscript Ireland, where I mentored students from all across the world — helping them build games and teaching the basics of programming, OOP concepts, Processing and much more. By the end, mentees built a flappy bird and snake game all by themselves.',
  },
  {
    role: 'Full Stack Developer',
    org: 'Omnipresent Tech',
    body: 'I built multiple projects from scratch which were used directly in production for companies like Aditya Birla Group (Hindalco project) and the Webel government project. I created dashboards with role-based access, integrated analytics, livestream from surveillance drones and CCTV cameras, file upload, SMS and email notification services, messaging features and more.',
  },
  {
    role: 'Digital India Makeathon — 1st Runners Up',
    org: 'Infosys, Chandigarh 2019',
    body: 'My team MicroBits represented our college at the Infosys Digital India Makeathon and secured 1st Runner-Up for building a social-media-integrated platform that makes it easier for citizens to reach officials, report problems, and build a community of people working for the betterment of the city.',
  },
  {
    role: 'Node.js Backend Developer',
    org: 'Office of the Advisor to the CM of NCT of Delhi',
    body: 'I worked as a Node.js backend intern for the Delhi Government under the Advisor to the CM, Sir Gopal Mohan, where I built the backend for the Mohalla Sabha project. My duties involved database administration, AWS architecture design and deployments, and backend development.',
  },
  {
    role: 'Node.js Backend Developer',
    org: 'INCAMPUS',
    body: "I helped build the INCAMPUS app's backend and deployed it at minimal cost with maximum scalability using Kubernetes and Docker images, implementing CI/CD with Jenkins.",
  },
  {
    role: 'Soft Skills Certification',
    org: 'AICTE',
    body: 'I attended a 6-week workshop on soft skills by AICTE, learning about proper communication, leadership, change management, time management and self-introspection.',
  },
  {
    role: 'Team Leader',
    org: 'Smart India Hackathon 2020',
    body: 'I was the team leader of Team MicroBits in the Smart India Hackathon. My team secured 1st position in the internal hackathon.',
  },
  {
    role: 'Mentor',
    org: 'WeCBR Hackathon',
    body: 'I was a mentor for the hackathon held at MSIT by WeCBR Hackathon 0.0.',
  },
  {
    role: '6-Month MEAN Stack Training',
    org: 'Croma Campus',
    body: 'I completed my 6-month industrial training at Croma Campus, learning about system design, MVC, and best practices related to web development.',
  },
  {
    role: 'MEAN Stack Intern',
    org: 'Biorev LLC',
    body: 'I worked as a MEAN stack development intern at Biorev LLC under the X-Inter program, working on 3D rendering of houses and interiors and landing pages. I learned the importance of documentation, writing clean code, making and pitching presentations, and maintaining work-life balance through tough night shifts.',
  },
  {
    role: 'MEAN Stack Intern',
    org: 'Futerox Interactive',
    body: 'I worked as a MEAN stack intern at Futerox Interactive for 6 weeks on landing pages, responsive design, the UI/UX of smaller projects like dashboards, and a Trip Planner MEAN app.',
  },
];

export const EDUCATION: EducationItem[] = [
  {
    institution: 'Maharaja Surajmal Institute of Technology',
    degree: 'B.Tech — Computer Science Engineering',
    period: '2017 – 2021',
    detail: 'Graduated with an aggregate of 8.3 CGPA.',
  },
  {
    institution: "St. George's School",
    degree: 'CBSE — Class XII',
    period: '2017',
    detail: 'Completed the 12th CBSE board with 86.6% aggregate.',
  },
];

export const PUBLICATION: Publication = {
  title: 'Benchmarking geospatial database on Kubernetes cluster',
  doi: '10.1186/s13634-021-00754-2',
  year: '2021',
  url: 'https://ui.adsabs.harvard.edu/abs/2021EJASP2021...43S/abstract',
};

export const SOCIALS: SocialLink[] = [
  {
    platform: 'GitHub',
    handle: 'MohakChugh',
    url: 'https://github.com/MohakChugh',
    icon: 'lucideGithub',
    blurb: 'Check out my personal projects and more.',
  },
  {
    platform: 'LinkedIn',
    handle: 'mohak-chugh',
    url: 'http://bit.ly/mohakchughLinkedIN',
    icon: 'lucideLinkedin',
    blurb: 'Connect with me on a professional level.',
  },
  {
    platform: 'Instagram',
    handle: 'mohak_projects',
    url: 'https://www.instagram.com/mohak_projects/',
    icon: 'lucideInstagram',
    blurb: 'A more personal look into my life and work.',
  },
];

export const AMCAT_URL =
  'https://drive.google.com/file/d/1onXAFPcuLo9ApD5vq-gKSFghLS6ev9DG/view?usp=sharing';
