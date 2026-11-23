// Built-in trig is not guaranteed bit-identical across engines; these use only + - * / so every peer agrees.

const PIO2_HI = 1.5707963267948966;
const PIO2_LO = 6.123233995736766e-17;

function sinSeries(r: number, r2: number): number {
  return r * (1 + r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800 + r2 * (-1 / 1307674368000 + r2 * (1 / 355687428096000)))))))));
}

function cosSeries(r2: number): number {
  return 1 + r2 * (-1 / 2 + r2 * (1 / 24 + r2 * (-1 / 720 + r2 * (1 / 40320 + r2 * (-1 / 3628800 + r2 * (1 / 479001600 + r2 * (-1 / 87178291200 + r2 * (1 / 20922789888000 + r2 * (-1 / 6402373705728000)))))))));
}

/** Accurate for |x| up to a few thousand radians. */
export function tan(x: number): number {
  const k = Math.round(x / PIO2_HI);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  const r2 = r * r;
  const s = sinSeries(r, r2);
  const c = cosSeries(r2);
  return (k & 1) === 0 ? s / c : -c / s;
}
