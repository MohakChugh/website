/** Shared content models for the portfolio. Plain interfaces — no logic. */

export interface ProjectLink {
  label: string;
  url: string;
  /** lucide icon name, e.g. 'lucideGithub' */
  icon: string;
}

export interface ProjectSection {
  heading?: string;
  /** paragraphs of body copy */
  body?: string[];
  /** optional bullet list */
  bullets?: string[];
}

export interface Project {
  slug: string;
  title: string;
  /** one-line summary used on cards */
  tagline: string;
  /** hero/card image path under /assets. Omit to render a themed gradient tile. */
  image?: string;
  /** lucide icon name shown on the gradient tile when there is no image */
  placeholderIcon?: string;
  /** optional looping video (mp4) shown on the detail hero in place of the image */
  video?: string;
  /** tech-stack chips */
  tags: string[];
  /** external links (demo, github, ppt) */
  links: ProjectLink[];
  /** detailed content sections for the detail page */
  sections: ProjectSection[];
  /** short kind label shown on the card, e.g. 'Dashboard' */
  kind: string;
}

export interface ExperienceItem {
  role: string;
  org: string;
  body: string;
}

export interface EducationItem {
  institution: string;
  degree: string;
  period: string;
  detail: string;
}

export interface Publication {
  title: string;
  doi: string;
  year: string;
  url: string;
}

export interface SkillBar {
  label: string;
  /** 0–100 */
  level: number;
}

export interface SkillCard {
  title: string;
  body: string;
  /** lucide icon name */
  icon: string;
}

export interface SocialLink {
  platform: string;
  handle: string;
  url: string;
  /** lucide icon name */
  icon: string;
  blurb: string;
}

export interface AskEntry {
  /** quick-chip / category key */
  category: string;
  question: string;
  /** keywords that should match this entry in the palette search */
  keywords: string[];
  /** answer paragraphs */
  answer: string[];
  /** optional route to deep-link to */
  route?: string;
  routeLabel?: string;
}
