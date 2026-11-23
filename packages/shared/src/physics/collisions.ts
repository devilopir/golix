import type { Disc, Plane, Segment, Vertex } from '../types.ts';

/** True when the disc was moving into the surface and bounced, which is when the original reports a collision. */
function bounce(disc: Disc, nx: number, ny: number, penetration: number, bCoef: number): boolean {
  disc.pos.x += nx * penetration;
  disc.pos.y += ny * penetration;
  let vn = disc.speed.x * nx + disc.speed.y * ny;
  if (!(vn < 0)) return false;
  vn *= disc.bCoef * bCoef + 1;
  disc.speed.x -= nx * vn;
  disc.speed.y -= ny * vn;
  return true;
}

/** Mirrors the original's arithmetic step for step, NaN included: a broken disc skips the test instead of spreading. */
export function collideDiscs(a: Disc, b: Disc): boolean {
  let nx = a.pos.x - b.pos.x;
  let ny = a.pos.y - b.pos.y;
  const dist2 = nx * nx + ny * ny;
  let rsum = a.radius + b.radius;
  if (!(dist2 > 0 && dist2 <= rsum * rsum)) return false;
  const dist = Math.sqrt(dist2);
  nx /= dist;
  ny /= dist;
  const f = a.invMass / (a.invMass + b.invMass);
  rsum -= dist;
  const moveA = rsum * f;
  a.pos.x += nx * moveA;
  a.pos.y += ny * moveA;
  const moveB = rsum - moveA;
  b.pos.x -= nx * moveB;
  b.pos.y -= ny * moveB;
  let vn = nx * (a.speed.x - b.speed.x) + ny * (a.speed.y - b.speed.y);
  if (!(vn < 0)) return false;
  vn *= a.bCoef * b.bCoef + 1;
  const pushA = f * vn;
  a.speed.x -= nx * pushA;
  a.speed.y -= ny * pushA;
  const pushB = vn - pushA;
  b.speed.x += nx * pushB;
  b.speed.y += ny * pushB;
  return true;
}

export function collidePlane(disc: Disc, plane: Plane): boolean {
  const n = plane.normal;
  const pen = plane.dist - (n.x * disc.pos.x + n.y * disc.pos.y) + disc.radius;
  return pen > 0 && bounce(disc, n.x, n.y, pen, plane.bCoef);
}

export function collideVertex(disc: Disc, vertex: Vertex): boolean {
  const dx = disc.pos.x - vertex.pos.x;
  const dy = disc.pos.y - vertex.pos.y;
  const dist2 = dx * dx + dy * dy;
  const r = disc.radius;
  if (!(dist2 > 0 && dist2 <= r * r)) return false;
  const dist = Math.sqrt(dist2);
  return bounce(disc, dx / dist, dy / dist, r - dist, vertex.bCoef);
}

export function collideSegment(disc: Disc, seg: Segment, vertexes: Vertex[]): boolean {
  const p = disc.pos;
  let nx: number;
  let ny: number;
  let h: number;
  if (seg.arc !== null) {
    const { center, radius, tan0, tan1 } = seg.arc;
    const wx = p.x - center.x;
    const wy = p.y - center.y;
    const inside = tan0.x * wx + tan0.y * wy > 0 && tan1.x * wx + tan1.y * wy > 0;
    if (inside === seg.curveF <= 0) return false;
    const len = Math.sqrt(wx * wx + wy * wy);
    if (len === 0) return false;
    h = len - radius;
    nx = wx / len;
    ny = wy / len;
  } else {
    const v0 = vertexes[seg.v0].pos;
    const v1 = vertexes[seg.v1].pos;
    const ex = v1.x - v0.x;
    const ey = v1.y - v0.y;
    if ((p.x - v0.x) * ex + (p.y - v0.y) * ey <= 0) return false;
    if ((p.x - v1.x) * ex + (p.y - v1.y) * ey >= 0) return false;
    const n = seg.normal!;
    nx = n.x;
    ny = n.y;
    h = nx * (p.x - v1.x) + ny * (p.y - v1.y);
  }
  if (seg.bias === 0) {
    if (h < 0) {
      h = -h;
      nx = -nx;
      ny = -ny;
    }
  } else {
    let b = seg.bias;
    if (b < 0) {
      b = -b;
      h = -h;
      nx = -nx;
      ny = -ny;
    }
    if (h < -b) return false;
  }
  return h < disc.radius && bounce(disc, nx, ny, disc.radius - h, seg.bCoef);
}
