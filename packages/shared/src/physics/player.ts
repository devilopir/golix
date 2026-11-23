import { CollisionFlags, InputFlags, type Disc, type Input, type PlayerPhysics } from '../types.ts';

const KICK_REACH = 4;
const DIAGONAL = 1 / Math.SQRT2;

/** `kicking` is the latched kick intent (SimPlayer.kicking), not the raw key state. */
export function applyPlayerInput(disc: Disc, input: Input, kicking: boolean, pp: PlayerPhysics): void {
  let dx = ((input & InputFlags.right) !== 0 ? 1 : 0) - ((input & InputFlags.left) !== 0 ? 1 : 0);
  let dy = ((input & InputFlags.down) !== 0 ? 1 : 0) - ((input & InputFlags.up) !== 0 ? 1 : 0);
  if (dx !== 0 && dy !== 0) {
    dx *= DIAGONAL;
    dy *= DIAGONAL;
  }
  const acc = kicking ? pp.kickingAcceleration : pp.acceleration;
  disc.speed.x += dx * acc;
  disc.speed.y += dy * acc;
  disc.damping = kicking ? pp.kickingDamping : pp.damping;
}

/** Returns the indexes in `discs` of the discs the kick reached; empty when it reached none. */
export function tryKick(playerDisc: Disc, discs: Disc[], pp: PlayerPhysics): number[] {
  const kicked: number[] = [];
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i];
    if (d === playerDisc || (d.cGroup & CollisionFlags.kick) === 0) continue;
    const dx = d.pos.x - playerDisc.pos.x;
    const dy = d.pos.y - playerDisc.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0 || dist - playerDisc.radius - d.radius >= KICK_REACH) continue;
    const nx = dx / dist;
    const ny = dy / dist;
    d.speed.x += nx * pp.kickStrength * d.invMass;
    d.speed.y += ny * pp.kickStrength * d.invMass;
    playerDisc.speed.x -= nx * pp.kickback * playerDisc.invMass;
    playerDisc.speed.y -= ny * pp.kickback * playerDisc.invMass;
    kicked.push(i);
  }
  return kicked;
}
