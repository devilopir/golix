import { describe, expect, it } from 'vitest';
import { stepWorld } from '../../src/physics/index.ts';
import { disc, joint, world } from './helpers.ts';

const free = { damping: 1, cMask: 0 };

function dist(w: ReturnType<typeof world>): number {
  const [a, b] = w.discs;
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
}

describe('joints', () => {
  it('rigid joint pulls a stretched pair back to its length', () => {
    const w = world({
      discs: [disc({ ...free, pos: { x: 0, y: 0 } }), disc({ ...free, pos: { x: 120, y: 0 } })],
      joints: [joint(0, 1, 100)],
    });
    stepWorld(w, 1);
    // Two iterations, each removing half of the remaining error: 20 → 10 → 5.
    expect(dist(w)).toBeCloseTo(105, 12);
    expect(w.discs[0].pos.x).toBeCloseTo(7.5, 12);
  });

  it('rigid joint removes relative speed along the joint', () => {
    const w = world({
      discs: [
        disc({ ...free, pos: { x: 0, y: 0 }, speed: { x: -1, y: 0.5 } }),
        disc({ ...free, pos: { x: 101, y: 0 }, speed: { x: 1, y: 0.5 } }),
      ],
      joints: [joint(0, 1, 100)],
    });
    stepWorld(w, 1);
    const [a, b] = w.discs;
    expect(b.speed.x - a.speed.x).toBeCloseTo(0, 12);
    expect(a.speed.y).toBe(0.5);
    expect(b.speed.y).toBe(0.5);
  });

  it('rigid joint respects inverse mass', () => {
    const w = world({
      discs: [disc({ ...free, pos: { x: 0, y: 0 }, invMass: 0 }), disc({ ...free, pos: { x: 120, y: 0 } })],
      joints: [joint(0, 1, 100)],
    });
    stepWorld(w, 1);
    expect(w.discs[0].pos.x).toBe(0);
    expect(w.discs[1].pos.x).toBeCloseTo(105, 12);
  });

  it('range joint is slack inside [min, max]', () => {
    const w = world({
      discs: [disc({ ...free, pos: { x: 0, y: 0 } }), disc({ ...free, pos: { x: 80, y: 0 }, speed: { x: 1, y: 0 } })],
      joints: [joint(0, 1, 50, 100)],
    });
    stepWorld(w, 1);
    expect(dist(w)).toBe(81);
    expect(w.discs[1].speed.x).toBe(1);
  });

  it('range joint clamps to max and keeps inward motion', () => {
    const w = world({
      discs: [disc({ ...free, pos: { x: 0, y: 0 } }), disc({ ...free, pos: { x: 120, y: 0 }, speed: { x: -3, y: 0 } })],
      joints: [joint(0, 1, 50, 100)],
    });
    stepWorld(w, 1);
    expect(dist(w)).toBeLessThan(117);
    expect(w.discs[1].speed.x).toBe(-3);
  });

  it('range joint pushes apart below min', () => {
    const w = world({
      discs: [disc({ ...free, pos: { x: 0, y: 0 } }), disc({ ...free, pos: { x: 30, y: 0 }, speed: { x: -1, y: 0 } })],
      joints: [joint(0, 1, 50, 100)],
    });
    stepWorld(w, 1);
    expect(dist(w)).toBeGreaterThan(29);
    expect(w.discs[1].speed.x).toBeGreaterThanOrEqual(w.discs[0].speed.x);
  });

  it('spring joint changes only speed, proportional to strength', () => {
    const w = world({
      discs: [disc({ ...free, pos: { x: 0, y: 0 } }), disc({ ...free, pos: { x: 110, y: 0 } })],
      joints: [joint(0, 1, 100, 100, 0.1)],
    });
    stepWorld(w, 1);
    expect(w.discs[0].pos.x).toBe(0);
    expect(w.discs[1].pos.x).toBe(110);
    // Per iteration: k = 0.1 * (-10) * 0.5 = -0.5, applied twice.
    expect(w.discs[0].speed.x).toBeCloseTo(1, 12);
    expect(w.discs[1].speed.x).toBeCloseTo(-1, 12);
  });

  it('strength 0 spring has no effect', () => {
    const w = world({
      discs: [disc({ ...free, pos: { x: 0, y: 0 } }), disc({ ...free, pos: { x: 150, y: 0 } })],
      joints: [joint(0, 1, 100, 100, 0)],
    });
    stepWorld(w, 1);
    expect(w.discs[0].speed.x).toBe(0);
    expect(w.discs[1].speed.x).toBe(0);
  });
});
