import type { TeamColors } from '@golix/shared';
import { css } from './color.ts';

export const PATTERN_SIZE = 64;

/** Angles are quantized to 1/256 of a turn, as the original stores them. */
export function stripeAngle(degrees: number): number {
  return (Math.floor((256 * degrees) / 360) * Math.PI) / 128;
}

/** At angle 0 stripes run vertically, colors ordered left to right. */
export function stripeRects(colors: readonly number[]): { color: number; x: number; width: number }[] {
  const width = PATTERN_SIZE / colors.length;
  return colors.map((color, i) => ({ color, x: i * width, width }));
}

export function createPatternCache(ctx: CanvasRenderingContext2D, makeCanvas: () => HTMLCanvasElement) {
  const cache = new Map<string, CanvasPattern>();
  return (colors: TeamColors): CanvasPattern => {
    const key = colors.colors.join(',');
    let pattern = cache.get(key);
    if (!pattern) {
      const surface = makeCanvas();
      surface.width = PATTERN_SIZE;
      surface.height = PATTERN_SIZE;
      const g = surface.getContext('2d')!;
      for (const s of stripeRects(colors.colors)) {
        g.fillStyle = css(s.color);
        g.fillRect(s.x, 0, s.width, PATTERN_SIZE);
      }
      pattern = ctx.createPattern(surface, 'repeat')!;
      cache.set(key, pattern);
    }
    return pattern;
  };
}
