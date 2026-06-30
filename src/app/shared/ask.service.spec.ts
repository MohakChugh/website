import { describe, expect, it, beforeEach } from 'vitest';
import { AskService } from './ask.service';

describe('AskService', () => {
  let service: AskService;

  beforeEach(() => {
    service = new AskService();
  });

  it('returns all entries for an empty query', () => {
    expect(service.search('').length).toBeGreaterThan(0);
    expect(service.search('   ').length).toBe(service.search('').length);
  });

  it('ranks the Amazon/work entry first for "amazon"', () => {
    const top = service.bestMatch('amazon');
    expect(top).not.toBeNull();
    expect(top!.answer.join(' ').toLowerCase()).toContain('amazon');
  });

  it('matches "projects" to the projects entry with a route', () => {
    const top = service.bestMatch('what have you built');
    expect(top).not.toBeNull();
    expect(top!.route).toBe('/projects');
  });

  it('matches contact intent', () => {
    const top = service.bestMatch('how do I reach you');
    expect(top?.route).toBe('/contact');
  });

  it('returns empty for gibberish with no keyword overlap', () => {
    expect(service.search('zzzqqq xyzzy').length).toBe(0);
  });

  it('byCategory filters case-insensitively', () => {
    expect(service.byCategory('skills').length).toBeGreaterThan(0);
    expect(service.byCategory('SKILLS').length).toBe(service.byCategory('skills').length);
  });

  it('scores exact keyword matches above incidental answer-text matches', () => {
    const results = service.search('devops');
    expect(results[0].keywords).toContain('devops');
  });
});
