import { Injectable } from '@angular/core';
import { ASK_ENTRIES } from '../data/ask.data';
import { AskEntry } from '../data/portfolio.models';

/**
 * Search over the local Ask-me knowledge base. Pure, synchronous, testable —
 * scores entries by keyword/question/category/answer matches against the query.
 */
@Injectable({ providedIn: 'root' })
export class AskService {
  private readonly entries = ASK_ENTRIES;

  /** Tokenise a query into lowercase word stems (length >= 2). */
  private tokens(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  }

  /** Score a single entry against query tokens. Higher is more relevant. */
  private score(entry: AskEntry, tokens: string[]): number {
    if (tokens.length === 0) return 0;
    const haystackKeywords = entry.keywords.map((k) => k.toLowerCase());
    const question = entry.question.toLowerCase();
    const category = entry.category.toLowerCase();
    const answer = entry.answer.join(' ').toLowerCase();

    let score = 0;
    for (const t of tokens) {
      if (haystackKeywords.includes(t)) score += 5;
      else if (haystackKeywords.some((k) => k.includes(t) || t.includes(k))) score += 3;
      if (category === t) score += 4;
      if (question.includes(t)) score += 2;
      if (answer.includes(t)) score += 1;
    }
    return score;
  }

  /**
   * Return entries matching the query, best first. An empty query returns all
   * entries in their natural order (so the palette shows everything initially).
   */
  search(query: string): AskEntry[] {
    const trimmed = query.trim();
    if (!trimmed) return [...this.entries];

    const tokens = this.tokens(trimmed);
    return this.entries
      .map((entry) => ({ entry, score: this.score(entry, tokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.entry);
  }

  /** Entries for a given quick-chip category. */
  byCategory(category: string): AskEntry[] {
    return this.entries.filter((e) => e.category.toLowerCase() === category.toLowerCase());
  }

  /** Best single answer for a query, or null when nothing matches. */
  bestMatch(query: string): AskEntry | null {
    return this.search(query)[0] ?? null;
  }
}
