import { describe, expect, test } from 'vitest';
import { parseStadium } from '../../src/stadium/parse.ts';
import { defaultStadiums } from '../../src/stadiums/index.ts';
import { CollisionFlags } from '../../src/types.ts';
import type { Segment, Vec2 } from '../../src/types.ts';

// Same side test the physics step uses to decide whether a point is on the arc's colliding part.
function arcCollides(s: Segment, p: Vec2): boolean {
  const { center, tan0, tan1 } = s.arc!;
  const w = { x: p.x - center.x, y: p.y - center.y };
  const inside = tan0.x * w.x + tan0.y * w.y > 0 && tan1.x * w.x + tan1.y * w.y > 0;
  return inside !== s.curveF <= 0;
}

test('ten built-ins with unique names, Standard first', () => {
  expect(defaultStadiums).toHaveLength(10);
  expect(defaultStadiums[0].name).toBe('Standard');
  expect(new Set(defaultStadiums.map((d) => d.name)).size).toBe(10);
});

describe.each(defaultStadiums.map((d) => [d.name, d.source] as const))('%s', (name, source) => {
  const s = parseStadium(source);
  const rink = s.bg.type === 'hockey';
  const goalX = rink ? s.bg.goalLine : s.bg.width;

  test('parses with its own name and a grass or hockey background', () => {
    expect(s.name).toBe(name);
    expect(['grass', 'hockey']).toContain(s.bg.type);
    expect(source).toContain(`name: '${name}'`);
  });

  test('goals: red concedes on the left, posts are fixed radius-8 discs at the goal ends', () => {
    expect(s.goals.map((g) => [g.team, Math.sign(g.p0.x)])).toEqual([[1, -1], [2, 1]]);
    const posts = s.discs.slice(1);
    expect(posts).toHaveLength(4);
    for (const g of s.goals) {
      for (const end of [g.p0, g.p1]) {
        expect(posts.some((d) => d.invMass === 0 && d.radius === 8 && d.bCoef === 0.5 && d.pos.x === end.x && d.pos.y === end.y)).toBe(true);
      }
      expect(Math.abs(g.p0.x)).toBe(goalX);
    }
  });

  test('nets bulge outward behind each goal line and stay inside the player bounds', () => {
    for (const g of s.goals) {
      const sx = Math.sign(g.p0.x);
      const net = s.segments.find((seg) => seg.arc && [seg.v0, seg.v1].every((v) => s.vertexes[v].pos.x === g.p0.x && Math.abs(s.vertexes[v].pos.y) === g.p1.y));
      expect(net).toBeDefined();
      const { center, radius } = net!.arc!;
      const back = { x: center.x + sx * radius, y: center.y };
      expect(Math.abs(back.x)).toBeGreaterThan(goalX);
      expect(Math.abs(back.x)).toBeLessThan(s.width);
      expect(arcCollides(net!, back)).toBe(true);
      expect(arcCollides(net!, { x: center.x - sx * radius, y: center.y })).toBe(false);
      expect(net!.cMask).toBe(rink ? CollisionFlags.all : CollisionFlags.ball);
    }
  });

  const ballArea = s.segments.filter((seg) => seg.cMask === CollisionFlags.ball && !seg.vis);

  test('ball area boundary is closed around the pitch', () => {
    const ballSegments = s.segments.filter((seg) => seg.cMask === CollisionFlags.ball);
    s.vertexes.forEach((v, i) => {
      if (v.cMask !== CollisionFlags.ball) return;
      expect(ballSegments.filter((seg) => seg.v0 === i || seg.v1 === i)).toHaveLength(2);
    });
    expect(ballArea.length).toBeGreaterThanOrEqual(6);
    expect(ballArea.every((seg) => seg.bCoef === 1)).toBe(true);
  });

  test('rounded corners are quarter circles that hold the ball inside', () => {
    const r = s.bg.cornerRadius;
    const corners = ballArea.filter((seg) => seg.arc);
    expect(corners).toHaveLength(r > 0 ? 4 : 0);
    for (const seg of corners) {
      const { center, radius } = seg.arc!;
      const sx = Math.sign(center.x);
      const sy = Math.sign(center.y);
      expect(radius).toBeCloseTo(r, 9);
      expect(center.x).toBeCloseTo(sx * (s.bg.width - r), 9);
      expect(center.y).toBeCloseTo(sy * (s.bg.height - r), 9);
      expect(arcCollides(seg, { x: center.x + sx * r, y: center.y + sy * r })).toBe(true);
    }
  });

  test('kickoff barrier: each half circle blocks the non-kicking side', () => {
    const k = s.bg.kickOffRadius;
    const barrier = s.segments.filter((seg) => seg.cMask === (CollisionFlags.red | CollisionFlags.blue));
    expect(barrier).toHaveLength(4);
    const red = barrier.find((seg) => seg.cGroup === CollisionFlags.redKO)!;
    const blue = barrier.find((seg) => seg.cGroup === CollisionFlags.blueKO)!;
    expect(red.arc!.radius).toBeCloseTo(k, 9);
    expect(arcCollides(red, { x: k, y: 0 })).toBe(true);
    expect(arcCollides(red, { x: -k, y: 0 })).toBe(false);
    expect(arcCollides(blue, { x: -k, y: 0 })).toBe(true);
    expect(arcCollides(blue, { x: k, y: 0 })).toBe(false);
    const lines = barrier.filter((seg) => seg.arc === null);
    expect(lines.every((seg) => seg.cGroup === (CollisionFlags.redKO | CollisionFlags.blueKO))).toBe(true);
  });

  test('players are bounded by planes and spawn between the circle and the goals', () => {
    expect(s.planes.map((p) => [p.normal.x, p.normal.y, p.dist])).toEqual([
      [0, 1, -s.height],
      [0, -1, -s.height],
      [1, 0, -s.width],
      [-1, 0, -s.width],
    ]);
    expect(s.spawnDistance).toBeGreaterThan(s.bg.kickOffRadius + s.playerPhysics.radius);
    expect(s.spawnDistance).toBeLessThan(goalX);
  });
});
