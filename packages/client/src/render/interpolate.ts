import type { GameState, Vec2 } from '@golix/shared';

export interface Positions {
  discs: Vec2[];
  players: Map<number, Vec2>;
}

export function interpolate(prev: GameState, curr: GameState, alpha: number): Positions {
  const sameDiscs = prev.stadium === curr.stadium && prev.discs.length === curr.discs.length;
  const discs = curr.discs.map((d, i) => (sameDiscs ? lerp(prev.discs[i]!.pos, d.pos, alpha) : { ...d.pos }));
  const prevPlayers = new Map(prev.players.map((p) => [p.id, p.disc]));
  const players = new Map<number, Vec2>();
  for (const p of curr.players) {
    if (!p.disc) continue;
    const before = prevPlayers.get(p.id);
    players.set(p.id, before ? lerp(before.pos, p.disc.pos, alpha) : { ...p.disc.pos });
  }
  return { discs, players };
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
