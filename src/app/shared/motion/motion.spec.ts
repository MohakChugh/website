import { describe, expect, it } from 'vitest';
import { litWordCount } from './scroll-fill.directive';
import { easeOutCubic, formatCount } from './count-up.directive';

describe('litWordCount', () => {
  const VH = 1000;
  const TOTAL = 10;

  it('lights nothing when the element is below the start line', () => {
    expect(litWordCount({ top: 900, height: 50 }, VH, TOTAL)).toBe(0);
  });

  it('lights everything when the element is above the end line', () => {
    expect(litWordCount({ top: 100, height: 50 }, VH, TOTAL)).toBe(TOTAL);
  });

  it('lights about half at the midpoint', () => {
    // start=800, end=350, midpoint top ≈ 575
    expect(litWordCount({ top: 575, height: 50 }, VH, TOTAL)).toBe(5);
  });

  it('never returns out-of-range counts', () => {
    for (const top of [-500, 0, 500, 1500]) {
      const n = litWordCount({ top, height: 50 }, VH, TOTAL);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(TOTAL);
    }
  });
});

describe('easeOutCubic', () => {
  it('maps endpoints to 0 and 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });
  it('is ahead of linear at the midpoint (ease-out)', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('formatCount', () => {
  it('rounds integer targets to whole numbers', () => {
    expect(formatCount(2.7, 13)).toBe('3');
    expect(formatCount(12.4, 13)).toBe('12');
  });
  it('keeps one decimal for fractional targets', () => {
    expect(formatCount(3.14159, 4.5)).toBe('3.1');
  });
});
