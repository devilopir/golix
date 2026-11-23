import { applyPlayerInput, stepWorld, tryKick, type Collision } from '../physics/index.ts';
import { CollisionFlags, InputFlags, Team, type Disc, type GameState, type Goal, type Joint, type JointEnd, type PlayingTeam, type RoomState, type Vec2 } from '../types.ts';
import { kickoffMask, physicsFor, PLAYER_CMASK, resetPositions } from './players.ts';

export type TickOutcome =
  /** discs: world indexes (stadium discs, then player discs) of every disc the kick reached. */
  | { type: 'kick'; playerId: number; discs: number[] }
  /** The joint at that index broke and is gone; reported from the highest index down, so each index holds at its turn. */
  | { type: 'jointBreak'; index: number }
  | { type: 'kickoff' }
  | { type: 'goal'; team: PlayingTeam } // scoring team
  | { type: 'victory'; team: PlayingTeam }
  | { type: 'positionsReset' }
  | { type: 'gameStop' };

const GOAL_TICKS = 150;
const END_TICKS = 300;
const PAUSED = 120;

function crossesGoal(prev: Vec2, cur: Vec2, goal: Goal): boolean {
  const mx = prev.x - cur.x;
  const my = prev.y - cur.y;
  const s0 = my * (goal.p0.x - cur.x) - mx * (goal.p0.y - cur.y) > 0;
  const s1 = my * (goal.p1.x - cur.x) - mx * (goal.p1.y - cur.y) > 0;
  if (s0 === s1) return false;
  const gx = goal.p1.x - goal.p0.x;
  const gy = goal.p1.y - goal.p0.y;
  const sCur = gy * (cur.x - goal.p0.x) - gx * (cur.y - goal.p0.y) > 0;
  const sPrev = gy * (prev.x - goal.p0.x) - gx * (prev.y - goal.p0.y) > 0;
  return sCur !== sPrev;
}

function findConcedingTeam(game: GameState, discs: Disc[], prev: (Vec2 | null)[]): PlayingTeam | null {
  for (let i = 0; i < discs.length; i++) {
    const p = prev[i];
    if (p === null) continue;
    for (const goal of game.stadium.goals) {
      if (crossesGoal(p, discs[i].pos, goal)) return goal.team;
    }
  }
  return null;
}

function timeUp(game: GameState): boolean {
  return game.timeLimit > 0 && game.time >= 60 * game.timeLimit;
}

function leader(game: GameState): PlayingTeam {
  return game.red > game.blue ? Team.red : Team.blue;
}

function setPlayerMasks(game: GameState, mask: number): void {
  for (const p of game.players) if (p.disc !== null) p.disc.cMask = mask;
}

function end(game: GameState, out: TickOutcome[]): void {
  game.phase = 'ended';
  game.phaseTicks = 0;
  game.winner = leader(game);
  out.push({ type: 'victory', team: game.winner });
}

/** World index of a joint end, or -1 when it is a player without a disc. */
function endIndex(game: GameState, end: JointEnd): number {
  if ('disc' in end) return end.disc;
  let index = game.discs.length;
  for (const p of game.players) {
    if (p.disc === null) continue;
    if (p.id === end.player) return index;
    index++;
  }
  return -1;
}

/** The game's joints with world indexes, leaving out those with an end that has no disc; `from` maps back to game.joints. */
function worldJoints(game: GameState): { joints: Joint[]; from: number[] } {
  const joints: Joint[] = [];
  const from: number[] = [];
  game.joints.forEach((j, i) => {
    const d0 = endIndex(game, j.a);
    const d1 = endIndex(game, j.b);
    if (d0 < 0 || d1 < 0) return;
    joints.push({ d0, d1, minLength: j.minLength, maxLength: j.maxLength, strength: j.strength, color: j.color, breakLength: j.breakLength });
    from.push(i);
  });
  return { joints, from };
}

/** `onCollision` hears each bounce with world disc indexes: stadium discs, then the discs of players in order. */
export function stepRoom(room: RoomState, onCollision?: (c: Collision) => void): TickOutcome[] {
  const game = room.game;
  if (game === null) return [];
  game.tick++;
  if (game.pauseCounter > 0) {
    if (game.pauseCounter !== PAUSED) game.pauseCounter--;
    return [];
  }

  const out: TickOutcome[] = [];
  const discs = [...game.discs];
  for (const p of game.players) if (p.disc !== null) discs.push(p.disc);

  const { min, rate, burst } = room.kickRateLimit;
  const tokenCap = rate * burst;
  for (const p of game.players) {
    if (p.disc === null) continue;
    const pp = physicsFor(game.stadium, room.players.find((rp) => rp.id === p.id)?.physics);
    if ((p.input & InputFlags.kick) === 0) p.kicking = false;
    if (p.kickCooldown > 0) p.kickCooldown--;
    if (p.kickTokens < tokenCap) p.kickTokens++;
    const kicked = p.kicking && p.kickCooldown <= 0 && p.kickTokens >= 0 ? tryKick(p.disc, discs, pp) : [];
    if (kicked.length > 0) {
      out.push({ type: 'kick', playerId: p.id, discs: kicked });
      p.kicking = false;
      p.kickCooldown = min;
      p.kickTokens -= rate;
    }
    applyPlayerInput(p.disc, p.input, p.kicking, pp);
  }

  const prev = discs.map((d) => ((d.cGroup & CollisionFlags.score) !== 0 ? { x: d.pos.x, y: d.pos.y } : null));
  const { vertexes, segments, planes } = game.stadium;
  const { joints, from } = worldJoints(game);
  const broken = stepWorld({ discs, vertexes, segments, planes, joints }, 1, onCollision);
  if (broken.length > 0) {
    const gone = new Set(broken.map((k) => from[k]));
    game.joints = game.joints.filter((_, i) => !gone.has(i));
    for (let k = broken.length - 1; k >= 0; k--) out.push({ type: 'jointBreak', index: from[broken[k]] });
  }

  game.phaseTicks++;
  switch (game.phase) {
    case 'kickoff': {
      setPlayerMasks(game, kickoffMask(game));
      const { x, y } = game.discs[0].speed;
      if (x * x + y * y > 0) {
        game.phase = 'playing';
        game.phaseTicks = 0;
        out.push({ type: 'kickoff' });
      }
      break;
    }
    case 'playing': {
      game.time += 1 / 60;
      setPlayerMasks(game, PLAYER_CMASK);
      const conceding = findConcedingTeam(game, discs, prev);
      if (conceding !== null) {
        const scoring = conceding === Team.red ? Team.blue : Team.red;
        if (scoring === Team.red) game.red++;
        else game.blue++;
        game.phase = 'goal';
        game.phaseTicks = 0;
        game.kickoffTeam = conceding;
        game.scoringTeam = scoring;
        out.push({ type: 'goal', team: scoring });
      } else if (timeUp(game)) {
        if (game.red !== game.blue) end(game, out);
        else game.overtime = true;
      }
      break;
    }
    case 'goal':
      if (game.phaseTicks < GOAL_TICKS) break;
      game.scoringTeam = null;
      if ((game.scoreLimit > 0 && Math.max(game.red, game.blue) >= game.scoreLimit) || (timeUp(game) && game.red !== game.blue)) {
        end(game, out);
      } else {
        resetPositions(room, game);
        game.phase = 'kickoff';
        game.phaseTicks = 0;
        out.push({ type: 'positionsReset' });
      }
      break;
    case 'ended':
      if (game.phaseTicks < END_TICKS) break;
      room.game = null;
      out.push({ type: 'gameStop' });
      break;
  }
  return out;
}
