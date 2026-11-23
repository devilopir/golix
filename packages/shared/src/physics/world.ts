import type { Disc, Joint, Plane, Segment, Vertex } from '../types.ts';
import { collideDiscs, collidePlane, collideSegment, collideVertex } from './collisions.ts';
import { collides } from './filter.ts';
import { solveJoint } from './joints.ts';

export interface World {
  /** Stadium discs first (joint d0/d1 index into these), then player discs in player id order. */
  discs: Disc[];
  vertexes: Vertex[];
  segments: Segment[];
  planes: Plane[];
  joints: Joint[];
}

const JOINT_ITERATIONS = 2;

/** A collision that bounced a disc; indexes are into the world's lists. */
export type Collision = { kind: 'disc'; disc: number; other: number } | { kind: 'plane' | 'segment' | 'vertex'; disc: number; index: number };

/**
 * dt scales only the position update (render extrapolation); the speed update is always one full tick.
 * `onCollision` hears each bounce, for host scripts; leaving it out costs nothing.
 * Returns the indexes of the joints that broke this step, in ascending order; they no longer pull.
 */
export function stepWorld(world: World, dt: number, onCollision?: (c: Collision) => void): number[] {
  const { discs, vertexes, segments, planes, joints } = world;

  for (const d of discs) {
    d.pos.x += dt * d.speed.x;
    d.pos.y += dt * d.speed.y;
    d.speed.x = d.damping * (d.speed.x + d.gravity.x);
    d.speed.y = d.damping * (d.speed.y + d.gravity.y);
  }

  for (let i = 0; i < discs.length; i++) {
    const a = discs[i];
    for (let j = i + 1; j < discs.length; j++) {
      const b = discs[j];
      if (collides(a.cGroup, a.cMask, b.cGroup, b.cMask) && collideDiscs(a, b)) onCollision?.({ kind: 'disc', disc: i, other: j });
    }
    if (a.invMass === 0) continue;
    for (let k = 0; k < planes.length; k++) {
      const p = planes[k];
      if (collides(a.cGroup, a.cMask, p.cGroup, p.cMask) && collidePlane(a, p)) onCollision?.({ kind: 'plane', disc: i, index: k });
    }
    for (let k = 0; k < segments.length; k++) {
      const s = segments[k];
      if (collides(a.cGroup, a.cMask, s.cGroup, s.cMask) && collideSegment(a, s, vertexes)) onCollision?.({ kind: 'segment', disc: i, index: k });
    }
    for (let k = 0; k < vertexes.length; k++) {
      const v = vertexes[k];
      if (collides(a.cGroup, a.cMask, v.cGroup, v.cMask) && collideVertex(a, v)) onCollision?.({ kind: 'vertex', disc: i, index: k });
    }
  }

  const broken: number[] = [];
  for (let k = 0; k < joints.length; k++) {
    const j = joints[k];
    if (j.breakLength === Infinity) continue;
    const dx = discs[j.d0].pos.x - discs[j.d1].pos.x;
    const dy = discs[j.d0].pos.y - discs[j.d1].pos.y;
    if (dx * dx + dy * dy > j.breakLength * j.breakLength) broken.push(k);
  }
  for (let it = 0; it < JOINT_ITERATIONS; it++) {
    for (let k = 0, b = 0; k < joints.length; k++) {
      if (broken[b] === k) b++;
      else solveJoint(joints[k], discs);
    }
  }
  return broken;
}
