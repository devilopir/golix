import { describe, expect, it } from 'vitest';
import { applyPlayerInput, stepWorld, tryKick } from '../../src/physics/index.ts';
import { CollisionFlags, InputFlags } from '../../src/types.ts';
import { ball, disc, player, playerPhysics as pp, world } from './helpers.ts';

function topSpeed(input: number, kicking: boolean): number {
  const p = player();
  const w = world({ discs: [p] });
  let last = { ...p.pos };
  let step = 0;
  for (let t = 0; t < 2000; t++) {
    applyPlayerInput(p, input, kicking, pp);
    stepWorld(w, 1);
    step = Math.hypot(p.pos.x - last.x, p.pos.y - last.y);
    last = { ...p.pos };
  }
  return step;
}

describe('applyPlayerInput', () => {
  it('reaches a/(1-d) per tick, slower while kicking', () => {
    expect(topSpeed(InputFlags.right, false)).toBeCloseTo(2.5, 9);
    expect(topSpeed(InputFlags.right, true)).toBeCloseTo(1.75, 9);
  });

  it('diagonal movement is as fast as straight', () => {
    expect(topSpeed(InputFlags.right | InputFlags.down, false)).toBeCloseTo(2.5, 9);
    expect(topSpeed(InputFlags.up | InputFlags.left, true)).toBeCloseTo(1.75, 9);
  });

  it('opposite keys cancel', () => {
    const p = player();
    applyPlayerInput(p, InputFlags.left | InputFlags.right | InputFlags.up, false, pp);
    expect(p.speed.x).toBe(0);
    expect(p.speed.y).toBeCloseTo(-0.1, 15);
  });

  it('sets damping from the kicking flag and ignores invMass', () => {
    const p = player();
    const physics = { ...pp, damping: 0.9, kickingDamping: 0.8 };
    applyPlayerInput(p, InputFlags.right, true, physics);
    expect(p.damping).toBe(0.8);
    expect(p.speed.x).toBeCloseTo(0.07, 15);
    applyPlayerInput(p, 0, false, physics);
    expect(p.damping).toBe(0.9);
  });
});

describe('tryKick', () => {
  it('kick range boundary is centre distance 29 for radii 15 + 10', () => {
    const near = ball({ x: 28.99, y: 0 });
    expect(tryKick(player(), [near], pp)).toEqual([0]);
    const far = ball({ x: 29.01, y: 0 });
    expect(tryKick(player(), [far], pp)).toEqual([]);
    expect(far.speed.x).toBe(0);
  });

  it('adds kickStrength * invMass along the centre line and kickback to the player', () => {
    const p = player();
    const b = ball({ x: 15, y: 20 });
    b.invMass = 1.5;
    expect(tryKick(p, [p, b], { ...pp, kickback: 2 })).toEqual([1]);
    expect(b.speed.x).toBeCloseTo(0.6 * 5 * 1.5, 12);
    expect(b.speed.y).toBeCloseTo(0.8 * 5 * 1.5, 12);
    expect(p.speed.x).toBeCloseTo(-0.6 * 2 * 0.5, 12);
    expect(p.speed.y).toBeCloseTo(-0.8 * 2 * 0.5, 12);
  });

  it('kicks every kickable disc in range and nothing else', () => {
    const p = player();
    const b1 = ball({ x: 26, y: 0 });
    const b2 = ball({ x: -26, y: 0 });
    const plain = disc({ pos: { x: 0, y: 26 }, cGroup: CollisionFlags.ball });
    const other = player({ x: 0, y: -26 });
    other.cGroup |= CollisionFlags.kick;
    expect(tryKick(p, [b1, b2, plain, other], pp)).toEqual([0, 1, 3]);
    expect(b1.speed.x).toBeCloseTo(5, 12);
    expect(b2.speed.x).toBeCloseTo(-5, 12);
    expect(plain.speed).toEqual({ x: 0, y: 0 });
    expect(other.speed.y).toBeCloseTo(-5 * other.invMass, 12);
  });
});
