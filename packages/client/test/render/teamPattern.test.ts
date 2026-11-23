import { describe, expect, it } from 'vitest';
import { createPatternCache, stripeAngle, stripeRects } from '../../src/render/teamPattern.ts';
import { createFakeCanvas } from './fakeCanvas.ts';

describe('team color pattern', () => {
  it('quantizes the angle to 1/256 turn', () => {
    expect(stripeAngle(0)).toBe(0);
    expect(stripeAngle(90)).toBe(Math.PI / 2);
    expect(stripeAngle(45)).toBe(Math.PI / 4);
    expect(stripeAngle(1)).toBe(0);
    expect(stripeAngle(359)).toBe((255 * Math.PI) / 128);
  });

  it('splits the pattern into equal vertical stripes in color order', () => {
    expect(stripeRects([0xff0000])).toEqual([{ color: 0xff0000, x: 0, width: 64 }]);
    expect(stripeRects([1, 2, 3]).map((s) => [s.color, s.x, s.width])).toEqual([
      [1, 0, 64 / 3],
      [2, 64 / 3, 64 / 3],
      [3, 128 / 3, 64 / 3],
    ]);
  });

  it('paints each color set once and reuses the pattern', () => {
    const { element, log } = createFakeCanvas(10, 10);
    const ctx = element.getContext('2d')!;
    log.length = 0;
    const get = createPatternCache(ctx, () => element.ownerDocument.createElement('canvas'));
    const a = get({ angle: 0, textColor: 0, colors: [0x112233, 0x445566] });
    const b = get({ angle: 90, textColor: 0xffffff, colors: [0x112233, 0x445566] });
    const c = get({ angle: 0, textColor: 0, colors: [0x112233] });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(log).toMatchSnapshot();
  });
});
