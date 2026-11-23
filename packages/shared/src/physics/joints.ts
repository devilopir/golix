import type { Disc, Joint } from '../types.ts';

export function solveJoint(joint: Joint, discs: Disc[]): void {
  const a = discs[joint.d0];
  const b = discs[joint.d1];
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= 0) return;
  const nx = dx / dist;
  const ny = dy / dist;
  // Only NaN (two infinite masses) falls back to half, as in the original; 1 and -1 give Infinity there too.
  let share = a.invMass / (a.invMass + b.invMass);
  if (Number.isNaN(share)) share = 0.5;

  let target: number;
  // +1: joint only pushes apart, -1: only pulls together, 0: both (fixed length).
  let dir: number;
  if (joint.minLength >= joint.maxLength) {
    target = joint.minLength;
    dir = 0;
  } else if (dist <= joint.minLength) {
    target = joint.minLength;
    dir = 1;
  } else if (dist >= joint.maxLength) {
    target = joint.maxLength;
    dir = -1;
  } else {
    return;
  }
  const err = target - dist;

  if (Number.isFinite(joint.strength)) {
    const k = joint.strength * err * 0.5;
    a.speed.x += nx * k * a.invMass;
    a.speed.y += ny * k * a.invMass;
    b.speed.x -= nx * k * b.invMass;
    b.speed.y -= ny * k * b.invMass;
    return;
  }

  const moveA = err * share;
  a.pos.x += nx * moveA * 0.5;
  a.pos.y += ny * moveA * 0.5;
  b.pos.x -= nx * (err - moveA) * 0.5;
  b.pos.y -= ny * (err - moveA) * 0.5;
  const vrel = nx * (a.speed.x - b.speed.x) + ny * (a.speed.y - b.speed.y);
  if (dir * vrel <= 0) {
    const q = vrel * share;
    a.speed.x -= nx * q;
    a.speed.y -= ny * q;
    b.speed.x += nx * (vrel - q);
    b.speed.y += ny * (vrel - q);
  }
}
