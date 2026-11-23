import { describe, expect, it } from 'vitest';
import { collides, stepWorld } from '../../src/physics/index.ts';
import { CollisionFlags } from '../../src/types.ts';
import { disc, plane, segment, vertex, world } from './helpers.ts';

const still = { damping: 1 };

describe('collides', () => {
  const f = CollisionFlags;
  it('needs both directions to match', () => {
    expect(collides(f.ball, f.all, f.wall, f.all)).toBe(true);
    expect(collides(f.red, f.ball | f.red | f.blue | f.wall, f.ball, f.all)).toBe(true);
    expect(collides(f.red, f.ball, f.wall, f.all)).toBe(false);
  });
  it('lets players through ball-only walls and blocks the ball', () => {
    expect(collides(f.red, f.all, f.wall, f.ball)).toBe(false);
    expect(collides(f.ball | f.kick | f.score, f.all, f.wall, f.ball)).toBe(true);
  });
  it('handles the sign bit of c3', () => {
    expect(collides(f.c3, f.c3, f.c3, f.c3)).toBe(true);
    expect(collides(f.c3, f.c2, f.c2, f.c3)).toBe(true);
    expect(collides(f.c3, f.c3, f.c2, f.c2)).toBe(false);
  });
  it('kickoff barrier stops only the matching team', () => {
    const playerMask = f.ball | f.red | f.blue | f.wall;
    expect(collides(f.blue, playerMask | f.blueKO, f.blueKO, f.blue)).toBe(true);
    expect(collides(f.red, playerMask, f.blueKO, f.red | f.blue)).toBe(false);
  });
  it('filtered pairs pass through each other', () => {
    const a = disc({ ...still, pos: { x: 0, y: 0 }, cGroup: f.red, cMask: f.ball });
    const b = disc({ ...still, pos: { x: 5, y: 0 }, cGroup: f.blue, cMask: f.ball });
    stepWorld(world({ discs: [a, b] }), 1);
    expect(a.pos.x).toBe(0);
    expect(b.pos.x).toBe(5);
  });
});

describe('disc vs disc', () => {
  it('separates by inverse mass share', () => {
    const a = disc({ ...still, pos: { x: 0, y: 0 }, invMass: 1 });
    const b = disc({ ...still, pos: { x: 16, y: 0 }, invMass: 0.5 });
    stepWorld(world({ discs: [a, b] }), 1);
    expect(b.pos.x - a.pos.x).toBeCloseTo(20, 12);
    expect(a.pos.x).toBeCloseTo(-4 * (2 / 3), 12);
    expect(b.pos.x).toBeCloseTo(16 + 4 * (1 / 3), 12);
  });

  it('impulse uses the product of bCoefs', () => {
    const a = disc({ ...still, pos: { x: -10, y: 0 }, speed: { x: 1, y: 0 }, bCoef: 0.5 });
    const b = disc({ ...still, pos: { x: 10, y: 0 }, bCoef: 0.5 });
    stepWorld(world({ discs: [a, b] }), 1);
    // e = 0.25, equal masses: va = (1 - e)/2, vb = (1 + e)/2
    expect(a.speed.x).toBeCloseTo(0.375, 12);
    expect(b.speed.x).toBeCloseTo(0.625, 12);
  });

  it('momentum with unequal masses', () => {
    const a = disc({ ...still, pos: { x: -10, y: 0 }, speed: { x: 2, y: 0 }, invMass: 0.5, bCoef: 1 });
    const b = disc({ ...still, pos: { x: 12, y: 0 }, invMass: 1, bCoef: 1 });
    stepWorld(world({ discs: [a, b] }), 1);
    expect(a.speed.x / 0.5 + b.speed.x / 1).toBeCloseTo(4, 12);
    expect(b.speed.x - a.speed.x).toBeCloseTo(2, 12);
  });

  it('separating discs keep their speed', () => {
    const a = disc({ ...still, pos: { x: -9, y: 0 }, speed: { x: -1, y: 0 } });
    const b = disc({ ...still, pos: { x: 9, y: 0 }, speed: { x: 1, y: 0 } });
    stepWorld(world({ discs: [a, b] }), 1);
    expect(a.speed.x).toBe(-1);
    expect(b.speed.x).toBe(1);
  });

  it('fixed disc does not move, and two overlapping fixed discs break into NaN as in the original', () => {
    const post = disc({ ...still, pos: { x: 0, y: 0 }, invMass: 0, radius: 8 });
    const b = disc({ ...still, pos: { x: 15, y: 0 }, speed: { x: -1, y: 0 } });
    stepWorld(world({ discs: [post, b] }), 1);
    expect(post.pos.x).toBe(0);
    expect(b.pos.x).toBeCloseTo(18, 12);
    expect(b.speed.x).toBeCloseTo(0.25, 12);

    const p2 = disc({ ...still, pos: { x: 5, y: 0 }, invMass: 0 });
    stepWorld(world({ discs: [post, p2] }), 1);
    expect(post.pos.x).toBeNaN();
    expect(p2.pos.x).toBeNaN();
  });

  it('a NaN disc skips the test, so it does not spread to the discs it is checked against', () => {
    const broken = disc({ ...still, pos: { x: NaN, y: 0 } });
    const b = disc({ ...still, pos: { x: 5, y: 0 } });
    stepWorld(world({ discs: [broken, b] }), 1);
    expect(b.pos).toEqual({ x: 5, y: 0 });
  });
});

describe('disc vs plane', () => {
  it('pushes out and reflects with bCoef product', () => {
    const d = disc({ ...still, pos: { x: 0, y: -195 }, speed: { x: 1, y: -2 }, bCoef: 0.5 });
    stepWorld(world({ discs: [d], planes: [plane(0, 1, -200, 1)] }), 1);
    expect(d.pos.y).toBeCloseTo(-190, 12);
    expect(d.speed.y).toBeCloseTo(1, 12);
    expect(d.speed.x).toBe(1);
  });

  it('ignores discs on the positive side', () => {
    const d = disc({ ...still, pos: { x: 0, y: -180 }, speed: { x: 0, y: -1 } });
    stepWorld(world({ discs: [d], planes: [plane(0, 1, -200)] }), 1);
    expect(d.pos.y).toBe(-181);
    expect(d.speed.y).toBe(-1);
  });

  it('invMass 0 discs skip walls', () => {
    const d = disc({ ...still, pos: { x: 0, y: -199 }, invMass: 0 });
    stepWorld(world({ discs: [d], planes: [plane(0, 1, -200)] }), 1);
    expect(d.pos.y).toBe(-199);
  });
});

describe('disc vs segment straight', () => {
  const vs = [vertex(-100, 0), vertex(100, 0)];

  it('collides from both sides when bias is 0', () => {
    const above = disc({ ...still, pos: { x: 0, y: -8 }, speed: { x: 0, y: 1 }, bCoef: 1 });
    stepWorld(world({ discs: [above], vertexes: vs, segments: [segment(vs, 0, 1)] }), 1);
    expect(above.pos.y).toBeCloseTo(-10, 12);
    expect(above.speed.y).toBeCloseTo(-1, 12);

    const below = disc({ ...still, pos: { x: 0, y: 8 }, speed: { x: 0, y: -1 }, bCoef: 1 });
    stepWorld(world({ discs: [below], vertexes: vs, segments: [segment(vs, 0, 1)] }), 1);
    expect(below.pos.y).toBeCloseTo(10, 12);
    expect(below.speed.y).toBeCloseTo(1, 12);
  });

  it('skips discs beyond the endpoints (corners belong to vertexes)', () => {
    const d = disc({ ...still, pos: { x: 105, y: -5 } });
    const ghosts = vs.map((v) => ({ ...v, cMask: 0 }));
    stepWorld(world({ discs: [d], vertexes: ghosts, segments: [segment(ghosts, 0, 1)] }), 1);
    expect(d.pos).toEqual({ x: 105, y: -5 });
  });

  // v0 → v1 points +x, so the normal (-e.y, e.x) with e = v0 - v1 is (0, -1): the bias side is y < 0.
  it('positive bias pushes out to its own side, even from behind within the thickness', () => {
    const seg = segment(vs, 0, 1, { bias: 30 });
    const behind = disc({ ...still, pos: { x: 0, y: 20 } });
    stepWorld(world({ discs: [behind], vertexes: vs, segments: [seg] }), 1);
    expect(behind.pos.y).toBeCloseTo(-10, 12);
  });

  it('bias ignores discs deeper than the thickness', () => {
    const seg = segment(vs, 0, 1, { bias: 30 });
    const deep = disc({ ...still, pos: { x: 0, y: 35 } });
    stepWorld(world({ discs: [deep], vertexes: vs, segments: [seg] }), 1);
    expect(deep.pos.y).toBe(35);
  });

  it('negative bias flips the side', () => {
    const seg = segment(vs, 0, 1, { bias: -30 });
    const d = disc({ ...still, pos: { x: 0, y: -5 } });
    stepWorld(world({ discs: [d], vertexes: vs, segments: [seg] }), 1);
    expect(d.pos.y).toBeCloseTo(10, 12);
  });
});

describe('disc vs segment curved', () => {
  // curve 90 from (0,-50) to (0,50): circle centre (-50,0), radius 50·√2, bulging towards +x.
  const vs = [vertex(0, -50), vertex(0, 50)];
  const r = 50 * Math.SQRT2;

  it('pushes a disc inside the arc back inside', () => {
    const d = disc({ ...still, pos: { x: 12, y: 0 }, speed: { x: 1, y: 0 }, bCoef: 1 });
    stepWorld(world({ discs: [d], vertexes: vs, segments: [segment(vs, 0, 1, { curve: 90 })] }), 1);
    expect(d.pos.x).toBeCloseTo(r - 50 - 10, 12);
    expect(d.speed.x).toBeCloseTo(-1, 12);
  });

  it('pushes a disc outside the arc further out', () => {
    const d = disc({ ...still, pos: { x: 28, y: 0 }, speed: { x: -1, y: 0 }, bCoef: 1 });
    stepWorld(world({ discs: [d], vertexes: vs, segments: [segment(vs, 0, 1, { curve: 90 })] }), 1);
    expect(d.pos.x).toBeCloseTo(r - 50 + 10, 12);
    expect(d.speed.x).toBeCloseTo(1, 12);
  });

  it('negative curve mirrors the arc', () => {
    const d = disc({ ...still, pos: { x: -12, y: 0 } });
    stepWorld(world({ discs: [d], vertexes: vs, segments: [segment(vs, 0, 1, { curve: -90 })] }), 1);
    expect(d.pos.x).toBeCloseTo(-(r - 50 - 10), 12);
  });

  it('ignores discs outside the arc wedge', () => {
    const d = disc({ ...still, pos: { x: -5, y: -60 } });
    stepWorld(world({ discs: [d], vertexes: vs, segments: [segment(vs, 0, 1, { curve: 90 })] }), 1);
    expect(d.pos).toEqual({ x: -5, y: -60 });
  });

  it('tiny curves are treated as straight', () => {
    const seg = segment(vs, 0, 1, { curve: 5 });
    expect(seg.arc).toBeNull();
    expect(seg.curveF).toBe(Infinity);
  });
});

describe('disc vs vertex', () => {
  it('bounces off a corner along the centre line', () => {
    const d = disc({ ...still, pos: { x: 6, y: 8 }, speed: { x: -0.6, y: -0.8 }, bCoef: 1 });
    stepWorld(world({ discs: [d], vertexes: [vertex(0, 0)] }), 1);
    const len = Math.hypot(d.pos.x, d.pos.y);
    expect(len).toBeCloseTo(10, 12);
    expect(d.speed.x).toBeCloseTo(0.6, 12);
    expect(d.speed.y).toBeCloseTo(0.8, 12);
  });

  it('ignores vertexes out of reach', () => {
    const d = disc({ ...still, pos: { x: 11, y: 0 } });
    stepWorld(world({ discs: [d], vertexes: [vertex(0, 0)] }), 1);
    expect(d.pos.x).toBe(11);
  });
});

describe('integration', () => {
  it('speed = damping * (speed + gravity)', () => {
    const d = disc({ pos: { x: 0, y: 0 }, speed: { x: 1, y: 0 }, gravity: { x: 0, y: 0.1 }, damping: 0.5 });
    stepWorld(world({ discs: [d] }), 1);
    expect(d.pos).toEqual({ x: 1, y: 0 });
    expect(d.speed.x).toBe(0.5);
    expect(d.speed.y).toBe(0.05);
  });

  it('fractional dt only scales the position update', () => {
    const d = disc({ speed: { x: 2, y: 0 }, damping: 0.5 });
    stepWorld(world({ discs: [d] }), 0.25);
    expect(d.pos.x).toBe(0.5);
    expect(d.speed.x).toBe(1);
  });
});

describe('collision reports', () => {
  it('names each bounce once with world indexes and stays quiet for discs moving apart', () => {
    const reports: unknown[] = [];
    const a = disc({ ...still, pos: { x: 0, y: 0 }, speed: { x: 1, y: 0 } });
    const b = disc({ ...still, pos: { x: 15, y: 0 } });
    const apart = disc({ ...still, pos: { x: 100, y: 0 }, speed: { x: 1, y: 0 } });
    const away = disc({ ...still, pos: { x: 115, y: 0 }, speed: { x: 5, y: 0 } });
    const wall = disc({ ...still, pos: { x: 0, y: -195 }, speed: { x: 0, y: -2 } });
    stepWorld(world({ discs: [a, b, apart, away, wall], planes: [plane(0, 1, -200, 1)] }), 1, (c) => reports.push(c));
    expect(reports).toEqual([
      { kind: 'disc', disc: 0, other: 1 },
      { kind: 'plane', disc: 4, index: 0 },
    ]);
  });
});
