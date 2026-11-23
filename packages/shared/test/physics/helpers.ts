import { CollisionFlags, type Disc, type Joint, type Plane, type PlayerPhysics, type Segment, type Vec2, type Vertex } from '../../src/types.ts';
import type { World } from '../../src/physics/index.ts';

export const playerPhysics: PlayerPhysics = {
  radius: 15,
  bCoef: 0.5,
  invMass: 0.5,
  damping: 0.96,
  cGroup: 0,
  acceleration: 0.1,
  kickingAcceleration: 0.07,
  kickingDamping: 0.96,
  kickStrength: 5,
  kickback: 0,
  gravity: { x: 0, y: 0 },
};

export function disc(props: Partial<Omit<Disc, 'pos' | 'speed'>> & { pos?: Vec2; speed?: Vec2 } = {}): Disc {
  return {
    pos: { x: 0, y: 0 },
    speed: { x: 0, y: 0 },
    gravity: { x: 0, y: 0 },
    radius: 10,
    invMass: 1,
    damping: 0.99,
    bCoef: 0.5,
    color: 0xffffff,
    cGroup: CollisionFlags.all,
    cMask: CollisionFlags.all,
    ...props,
  };
}

export function ball(pos: Vec2 = { x: 0, y: 0 }, speed: Vec2 = { x: 0, y: 0 }): Disc {
  return disc({ pos, speed, cGroup: CollisionFlags.ball | CollisionFlags.kick | CollisionFlags.score });
}

export function player(pos: Vec2 = { x: 0, y: 0 }, team: 'red' | 'blue' = 'red'): Disc {
  return disc({
    pos,
    radius: playerPhysics.radius,
    invMass: playerPhysics.invMass,
    damping: playerPhysics.damping,
    bCoef: playerPhysics.bCoef,
    cGroup: CollisionFlags[team],
    cMask: CollisionFlags.ball | CollisionFlags.red | CollisionFlags.blue | CollisionFlags.wall,
  });
}

export function vertex(x: number, y: number, bCoef = 1): Vertex {
  return { pos: { x, y }, bCoef, cGroup: CollisionFlags.wall, cMask: CollisionFlags.all };
}

export function plane(nx: number, ny: number, dist: number, bCoef = 1): Plane {
  const len = Math.sqrt(nx * nx + ny * ny);
  return { normal: { x: nx / len, y: ny / len }, dist, bCoef, cGroup: CollisionFlags.wall, cMask: CollisionFlags.all };
}

/** Mirrors the stadium loader's curve → arc precomputation. */
export function segment(vertexes: Vertex[], v0: number, v1: number, opts: { curve?: number; bias?: number; bCoef?: number; cMask?: number } = {}): Segment {
  let c = ((opts.curve ?? 0) * Math.PI) / 180;
  let bias = opts.bias ?? 0;
  if (c < 0) {
    c = -c;
    [v0, v1] = [v1, v0];
    bias = -bias;
  }
  const curveF = c > 0.17435839227423353 && c < 5.934119456780721 ? 1 / Math.tan(c / 2) : Infinity;
  const p0 = vertexes[v0].pos;
  const p1 = vertexes[v1].pos;
  let normal: Vec2 | null = null;
  let arc: Segment['arc'] = null;
  if (Number.isFinite(curveF)) {
    const mx = 0.5 * (p1.x - p0.x);
    const my = 0.5 * (p1.y - p0.y);
    const center = { x: p0.x + mx - my * curveF, y: p0.y + my + mx * curveF };
    const radius = Math.hypot(p0.x - center.x, p0.y - center.y);
    arc = {
      center,
      radius,
      tan0: { x: center.y - p0.y, y: p0.x - center.x },
      tan1: { x: p1.y - center.y, y: center.x - p1.x },
    };
  } else {
    const ex = p0.x - p1.x;
    const ey = p0.y - p1.y;
    const len = Math.hypot(ex, ey);
    normal = { x: -ey / len, y: ex / len };
  }
  return {
    v0,
    v1,
    bCoef: opts.bCoef ?? 1,
    cGroup: CollisionFlags.wall,
    cMask: opts.cMask ?? CollisionFlags.all,
    bias,
    vis: true,
    color: 0,
    curveF,
    normal,
    arc,
  };
}

export function joint(d0: number, d1: number, minLength: number, maxLength = minLength, strength = Infinity, breakLength = Infinity): Joint {
  return { d0, d1, minLength, maxLength, strength, color: 0, breakLength };
}

export function world(parts: Partial<World>): World {
  return { discs: [], vertexes: [], segments: [], planes: [], joints: [], ...parts };
}
