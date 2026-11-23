import { PLAYER_PHYSICS_KEYS, type Disc, type GameState, type RoomState, type TeamColors } from '../types.ts';
import { cloneDisc } from './players.ts';

function cloneColors(c: TeamColors): TeamColors {
  return { ...c, colors: [...c.colors] };
}

function cloneGame(g: GameState): GameState {
  return {
    ...g,
    discs: g.discs.map(cloneDisc),
    players: g.players.map((p) => ({ ...p, disc: p.disc === null ? null : cloneDisc(p.disc) })),
  };
}

/** The parsed Stadium is immutable and shared with the copy. */
export function cloneRoom(room: RoomState): RoomState {
  return {
    ...room,
    players: room.players.map((p) => ({ ...p })),
    redColors: cloneColors(room.redColors),
    blueColors: cloneColors(room.blueColors),
    kickRateLimit: { ...room.kickRateLimit },
    game: room.game === null ? null : cloneGame(room.game),
  };
}

const view = new DataView(new ArrayBuffer(8));

class Hasher {
  h = 0x811c9dc5;

  int(v: number): void {
    this.h = Math.imul(this.h ^ (v | 0), 0x01000193);
  }

  float(v: number): void {
    view.setFloat64(0, v, true);
    this.int(view.getInt32(0, true));
    this.int(view.getInt32(4, true));
  }

  disc(d: Disc): void {
    for (const v of [d.pos.x, d.pos.y, d.speed.x, d.speed.y, d.gravity.x, d.gravity.y, d.radius, d.invMass, d.damping, d.bCoef]) this.float(v);
    this.int(d.color);
    this.int(d.cGroup);
    this.int(d.cMask);
  }
}

const PHASES = ['kickoff', 'playing', 'goal', 'ended'] as const;

/** Covers everything the simulation reads; names, avatars, colors and pings are left out. */
export function hashRoom(room: RoomState): number {
  const h = new Hasher();
  for (const p of room.players) {
    h.int(p.id);
    h.int(p.team);
    for (const k of PLAYER_PHYSICS_KEYS) {
      const v = p.physics?.[k];
      if (v !== undefined) h.float(v);
      else h.int(-1);
    }
  }
  h.int(room.scoreLimit);
  h.int(room.timeLimit);
  h.int(room.kickRateLimit.min);
  h.int(room.kickRateLimit.rate);
  h.int(room.kickRateLimit.burst);
  for (let i = 0; i < room.stadiumSource.length; i++) h.int(room.stadiumSource.charCodeAt(i));
  const g = room.game;
  if (g === null) return h.h >>> 0;
  for (const v of [g.tick, PHASES.indexOf(g.phase), g.phaseTicks, g.pauseCounter, g.red, g.blue, g.kickoffTeam, g.scoringTeam ?? 0, g.winner ?? 0, g.scoreLimit, g.timeLimit]) h.int(v);
  h.float(g.time);
  h.int(g.overtime ? 1 : 0);
  for (const d of g.discs) h.disc(d);
  h.int(g.joints.length);
  for (const j of g.joints) {
    for (const end of [j.a, j.b]) {
      if ('disc' in end) h.int(end.disc);
      else h.int(-1 - end.player);
    }
    for (const v of [j.minLength, j.maxLength, j.strength, j.breakLength]) h.float(v);
  }
  for (const p of g.players) {
    for (const v of [p.id, p.team, p.input, p.kicking ? 1 : 0, p.kickCooldown, p.kickTokens]) h.int(v);
    if (p.disc === null) h.int(-1);
    else h.disc(p.disc);
  }
  return h.h >>> 0;
}
