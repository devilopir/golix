import { parseStadium } from '../stadium/parse.ts';
import { CollisionFlags, Team, type Disc, type GameState, type PlayerPhysics, type PlayerPhysicsOverrides, type PlayingTeam, type RoomState, type SimPlayer, type Stadium, type Vec2 } from '../types.ts';

export const PLAYER_CMASK: number = CollisionFlags.ball | CollisionFlags.red | CollisionFlags.blue | CollisionFlags.wall;
const SPAWN_SPACING = 55;

/** Bounded, since a long-running room sees every stadium its admins load. */
const STADIUM_CACHE_SIZE = 8;
const stadiumCache = new Map<string, Stadium>();

export function getStadium(source: string): Stadium {
  let stadium = stadiumCache.get(source);
  if (stadium === undefined) {
    stadium = parseStadium(source);
    stadiumCache.set(source, stadium);
    if (stadiumCache.size > STADIUM_CACHE_SIZE) stadiumCache.delete(stadiumCache.keys().next().value!);
  }
  return stadium;
}

export function cloneDisc(d: Disc): Disc {
  return { ...d, pos: { ...d.pos }, speed: { ...d.speed }, gravity: { ...d.gravity } };
}

function side(team: PlayingTeam): number {
  return team === Team.red ? -1 : 1;
}

function spawnPoints(stadium: Stadium, team: PlayingTeam): Vec2[] {
  return team === Team.red ? stadium.redSpawnPoints : stadium.blueSpawnPoints;
}

export function kickoffMask(game: GameState): number {
  return PLAYER_CMASK | (game.kickoffTeam === Team.red ? CollisionFlags.redKO : CollisionFlags.blueKO);
}

/** The stadium's player physics with one player's changes on top. */
export function physicsFor(stadium: Stadium, overrides: PlayerPhysicsOverrides | undefined): PlayerPhysics {
  return overrides === undefined ? stadium.playerPhysics : { ...stadium.playerPhysics, ...overrides };
}

function createDisc(pp: PlayerPhysics, team: PlayingTeam, pos: Vec2): Disc {
  return {
    pos: { ...pos },
    speed: { x: 0, y: 0 },
    gravity: { ...pp.gravity },
    radius: pp.radius,
    invMass: pp.invMass,
    damping: pp.damping,
    bCoef: pp.bCoef,
    color: 0,
    cGroup: (team === Team.red ? CollisionFlags.red : CollisionFlags.blue) | pp.cGroup,
    cMask: PLAYER_CMASK,
  };
}

/** Unlike the original, a fresh disc keeps the held input, so a key held through a reset moves the player at once. */
function giveDisc(pp: PlayerPhysics, sim: SimPlayer, team: PlayingTeam, pos: Vec2): void {
  sim.disc = createDisc(pp, team, pos);
}

/** Gives a player who enters a team while the game runs a fresh disc at the stadium's edge, or removes it for spectators. */
export function assignMidGameDisc(game: GameState, sim: SimPlayer, overrides: PlayerPhysicsOverrides | undefined): void {
  if (sim.team === Team.spectators) {
    sim.disc = null;
    return;
  }
  const points = spawnPoints(game.stadium, sim.team);
  giveDisc(physicsFor(game.stadium, overrides), sim, sim.team, points.length > 0 ? points[points.length - 1] : { x: side(sim.team) * game.stadium.width, y: 0 });
  sim.kicking = false;
}

export function resetPositions(room: RoomState, game: GameState): void {
  const { stadium } = game;
  const resetCount = stadium.kickOffReset === 'full' ? stadium.discs.length : 1;
  for (let i = 0; i < resetCount; i++) game.discs[i] = cloneDisc(stadium.discs[i]);

  const counters = { [Team.red]: 0, [Team.blue]: 0 };
  for (const rp of room.players) {
    const sim = game.players.find((p) => p.id === rp.id);
    if (sim === undefined || sim.team === Team.spectators) continue;
    const k = counters[sim.team]++;
    const points = spawnPoints(stadium, sim.team);
    let pos: Vec2;
    if (points.length > 0) {
      pos = points[Math.min(k, points.length - 1)];
    } else {
      let h = (k + 1) >> 1;
      if ((k & 1) === 0) h = -h;
      pos = { x: side(sim.team) * stadium.spawnDistance, y: SPAWN_SPACING * h };
    }
    // As in the original, a reset gives players fresh discs, dropping radius and other script changes; the kickoff step adds the barrier mask.
    giveDisc(physicsFor(stadium, rp.physics), sim, sim.team, pos);
  }
}
