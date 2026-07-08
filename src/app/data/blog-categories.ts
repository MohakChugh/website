/**
 * Blog category definitions — maps 50+ raw tags into 5 navigable groups.
 * Used by BlogService for category filtering and the blog-list UI.
 */

export interface BlogCategory {
  key: string;
  label: string;
  tags: string[];
}

export const BLOG_CATEGORIES: BlogCategory[] = [
  {
    key: 'ml-gpu',
    label: 'ML & GPU',
    tags: [
      'gpu', 'attention', 'transformers', 'llm', 'llm-inference', 'speculative-decoding',
      'ml-systems', 'flash-attention', 'cuda', 'interpretability', 'neuroscience',
      'anthropic', 'mechanistic-interpretability', 'long-context', 'inference', 'kv-cache',
      'vector-search', 'quantization', 'ann', 'ai', 'parallel-computing',
    ],
  },
  {
    key: 'systems',
    label: 'Systems & Infra',
    tags: [
      'performance', 'systems', 'systems-programming', 'io_uring', 'linux-kernel',
      'linux', 'kernel', 'memory-management', 'async-io', 'simd', 'cpu-architecture',
      'cxl', 'memory-pooling', 'disaggregated-memory', 'datacenter-architecture', 'hardware',
    ],
  },
  {
    key: 'data',
    label: 'Data Engineering',
    tags: [
      'databases', 'data-engineering', 'iceberg', 'file-formats', 'lakehouse',
      'data-structures', 'algorithms', 'caching', 'object-storage', 's3',
    ],
  },
  {
    key: 'distributed',
    label: 'Distributed',
    tags: [
      'distributed-systems', 'consistency', 'testing', 'reliability', 'simulation',
      'fault-injection',
    ],
  },
  {
    key: 'frontend',
    label: 'Frontend',
    tags: ['angular', 'tailwind', 'spartan-ng', 'ssg', 'typescript'],
  },
];

/** Quick lookup: tag → category key */
export const TAG_TO_CATEGORY = new Map<string, string>(
  BLOG_CATEGORIES.flatMap((c) => c.tags.map((t) => [t, c.key])),
);
