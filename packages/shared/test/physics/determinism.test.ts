import { describe, expect, it } from 'vitest';
import { applyPlayerInput, stepWorld, tryKick, type World } from '../../src/physics/index.ts';
import { CollisionFlags } from '../../src/types.ts';
import { ball, disc, joint, plane, player, playerPhysics as pp, segment, vertex, world } from './helpers.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function hashWorld(w: World): number {
  const buf = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  for (const d of w.discs) {
    for (const v of [d.pos.x, d.pos.y, d.speed.x, d.speed.y]) {
      buf.setFloat64(0, v, true);
      for (let i = 0; i < 8; i++) h = Math.imul(h ^ buf.getUint8(i), 0x01000193);
    }
  }
  return h >>> 0;
}

function arena(): World {
  const ballOnly = CollisionFlags.ball;
  const vertexes = [
    vertex(-370, -200), vertex(370, -200), vertex(370, 200), vertex(-370, 200),
    vertex(-370, -64), vertex(-370, 64), vertex(370, -64), vertex(370, 64),
    vertex(-400, -64), vertex(-400, 64), vertex(400, -64), vertex(400, 64),
  ];
  for (const v of vertexes) v.cMask = ballOnly;
  const segments = [
    segment(vertexes, 0, 1, { cMask: ballOnly }),
    segment(vertexes, 3, 2, { cMask: ballOnly }),
    segment(vertexes, 0, 4, { cMask: ballOnly }),
    segment(vertexes, 5, 3, { cMask: ballOnly }),
    segment(vertexes, 1, 6, { cMask: ballOnly }),
    segment(vertexes, 7, 2, { cMask: ballOnly }),
    segment(vertexes, 4, 8, { curve: -60, cMask: ballOnly, bCoef: 0.1 }),
    segment(vertexes, 8, 9, { cMask: ballOnly, bCoef: 0.1, bias: -10 }),
    segment(vertexes, 9, 5, { curve: -60, cMask: ballOnly, bCoef: 0.1 }),
    segment(vertexes, 6, 10, { curve: 60, cMask: ballOnly, bCoef: 0.1 }),
    segment(vertexes, 10, 11, { cMask: ballOnly, bCoef: 0.1 }),
    segment(vertexes, 11, 7, { curve: 60, cMask: ballOnly, bCoef: 0.1 }),
  ];
  const planes = [plane(0, 1, -230, 0.1), plane(0, -1, -230, 0.1), plane(1, 0, -440, 0.1), plane(-1, 0, -440, 0.1)];
  const post = (x: number, y: number) => disc({ pos: { x, y }, radius: 8, invMass: 0, cGroup: CollisionFlags.wall });
  const swing = disc({ pos: { x: 0, y: -150 }, radius: 6, invMass: 2, damping: 1, gravity: { x: 0, y: 0.02 } });
  const anchor = disc({ pos: { x: 0, y: -210 }, radius: 3, invMass: 0, cMask: 0 });
  const discs = [ball(), post(-370, -64), post(-370, 64), post(370, -64), post(370, 64), anchor, swing];
  const joints = [joint(5, 6, 60), joint(0, 6, 40, 120, 0.02)];
  for (let i = 0; i < 10; i++) {
    const team = i < 5 ? 'red' : 'blue';
    discs.push(player({ x: (team === 'red' ? -1 : 1) * 170, y: ((i % 5) - 2) * 55 }, team));
  }
  return world({ discs, vertexes, segments, planes, joints });
}

function run(ticks: number, seed: number): number {
  const w = arena();
  const rand = mulberry32(seed);
  const players = w.discs.slice(7);
  const inputs = players.map(() => 0);
  const kicking = players.map(() => false);
  for (let t = 0; t < ticks; t++) {
    players.forEach((p, i) => {
      if (rand() % 20 === 0) {
        const prev = inputs[i];
        inputs[i] = rand() & 31;
        if ((inputs[i] & 16) !== 0 && (prev & 16) === 0) kicking[i] = true;
      }
      if ((inputs[i] & 16) === 0) kicking[i] = false;
      if (kicking[i] && tryKick(p, w.discs, pp).length > 0) kicking[i] = false;
      applyPlayerInput(p, inputs[i], kicking[i], pp);
    });
    stepWorld(w, 1);
  }
  for (const d of w.discs) {
    expect(Number.isFinite(d.pos.x) && Number.isFinite(d.pos.y)).toBe(true);
  }
  return hashWorld(w);
}

describe('determinism', () => {
  it('10 players + ball + walls + joints: 10,000 ticks hash to a fixed value', () => {
    const h = run(10_000, 1234);
    expect(run(10_000, 1234)).toBe(h);
    expect(h).toBe(2252380719);
  });
});
