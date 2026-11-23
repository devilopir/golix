import type { Color } from '@golix/shared';

/** Keeps the low 24 bits like the original, so -1 ("transparent") comes out white where it is drawn at all. */
export function css(c: Color): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

/** Blends toward white (t > 0) or black (t < 0). */
export function shade(c: Color, t: number): Color {
  const to = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  const channel = (shift: number) => {
    const v = (c >> shift) & 255;
    return Math.round(v + (to - v) * k) << shift;
  };
  return channel(16) | channel(8) | channel(0);
}
