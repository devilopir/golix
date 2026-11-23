import { describe, expect, it } from 'vitest';
import { applyPlayerInput, stepWorld, tryKick } from '../../src/physics/index.ts';
import { InputFlags } from '../../src/types.ts';
import { ball, player, playerPhysics as pp, world } from './helpers.ts';

function accelerationCurve(ticks: number): number[] {
  const p = player();
  const w = world({ discs: [p] });
  const steps: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const x = p.pos.x;
    applyPlayerInput(p, InputFlags.right, false, pp);
    stepWorld(w, 1);
    steps.push(p.pos.x - x);
  }
  return steps;
}

function ticksTo(fraction: number): number {
  return accelerationCurve(500).findIndex((s) => s >= 2.5 * fraction) + 1;
}

describe('derived quantities', () => {
  it('acceleration curve follows a(1-d^n)/(1-d)', () => {
    const curve = accelerationCurve(120);
    curve.forEach((s, i) => expect(s).toBeCloseTo((0.1 * (1 - 0.96 ** (i + 1))) / 0.04, 12));
    expect(curve[0]).toBeCloseTo(0.1, 15);
    expect(curve[59]).toBeCloseTo(2.284, 3);
  });

  it('ticks to 50% and 90% of top speed', () => {
    expect(ticksTo(0.5)).toBe(17);
    expect(ticksTo(0.9)).toBe(57);
  });

  it('glide distance after releasing at top speed is about 60', () => {
    const p = player();
    const w = world({ discs: [p] });
    for (let t = 0; t < 2000; t++) {
      applyPlayerInput(p, InputFlags.right, false, pp);
      stepWorld(w, 1);
    }
    const x0 = p.pos.x;
    for (let t = 0; t < 2000; t++) {
      applyPlayerInput(p, 0, false, pp);
      stepWorld(w, 1);
    }
    expect(p.pos.x - x0).toBeCloseTo(60, 6);
  });

  it('kick gives a resting ball 5/tick and it rolls about 500 units', () => {
    const p = player();
    const b = ball({ x: 26, y: 0 });
    expect(tryKick(p, [b], pp)).toEqual([0]);
    expect(b.speed.x).toBeCloseTo(5, 12);
    const w = world({ discs: [b] });
    for (let t = 0; t < 5000; t++) stepWorld(w, 1);
    expect(b.pos.x - 26).toBeCloseTo(500, 6);
  });

  it('ball speed halves in 69 ticks', () => {
    const b = ball({ x: 0, y: 0 }, { x: 5, y: 0 });
    const w = world({ discs: [b] });
    let t = 0;
    while (b.speed.x > 2.5) {
      stepWorld(w, 1);
      t++;
    }
    expect(t).toBe(69);
  });
});
