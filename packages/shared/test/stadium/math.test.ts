import { describe, expect, test } from 'vitest';
import { tan } from '../../src/math.ts';

function relErr(x: number): number {
  const expected = Math.tan(x);
  return Math.abs(tan(x) - expected) / Math.abs(expected);
}

describe('tan', () => {
  test('matches Math.tan to 1e-12 relative over several periods', () => {
    for (let i = -4000; i <= 4000; i++) expect(relErr(i * 0.00157 + 0.0001)).toBeLessThan(1e-12);
  });

  test('matches Math.tan for every half-angle a stadium curve can use', () => {
    for (let deg = 0.5; deg < 360; deg += 0.25) expect(relErr((deg * Math.PI) / 180 / 2)).toBeLessThan(1e-12);
  });

  test('agrees with Math.tan in sign at the double nearest pi/2', () => {
    expect(tan(0)).toBe(0);
    expect(tan(Math.PI / 2)).toBeGreaterThan(1e16);
    expect(relErr(Math.PI / 2)).toBeLessThan(1e-12);
    expect(relErr(-Math.PI / 2)).toBeLessThan(1e-12);
  });
});
