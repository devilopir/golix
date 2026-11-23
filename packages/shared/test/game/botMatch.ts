import { hashRoom, stepRoom, type TickOutcome } from '../../src/game/index.ts';
import { InputFlags, Team, type RoomEvent, type RoomState } from '../../src/types.ts';
import { join, newRoom, send } from './helpers.ts';

export const TICKS = 10_000;

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Players chase the ball with noisy inputs; events depend only on the room state, so they are reproducible. */
export function botEvents(room: RoomState, t: number, rand: () => number): RoomEvent[] {
  const events: RoomEvent[] = [];
  const g = room.game;
  if (g === null) return events;
  const ball = g.discs[0].pos;
  for (const p of g.players) {
    if (p.disc === null || rand() % 6 !== 0) continue;
    let input = rand() % 4 === 0 ? rand() % 16 : 0;
    if (input === 0) {
      input |= ball.x > p.disc.pos.x ? InputFlags.right : InputFlags.left;
      input |= ball.y > p.disc.pos.y ? InputFlags.down : InputFlags.up;
    }
    if (rand() % 3 === 0) input |= InputFlags.kick;
    events.push({ type: 'input', playerId: p.id, input });
  }
  if (t === 4000) events.push({ type: 'setPaused', paused: true, byPlayer: null });
  if (t === 4100) events.push({ type: 'setPaused', paused: false, byPlayer: null });
  if (t === 6000) events.push({ type: 'setTeam', playerId: 4, team: Team.red, byPlayer: null, announce: false });
  return events;
}

export function setup(): RoomState {
  const room = newRoom();
  send(room, [
    { type: 'setTimeLimit', value: 0, byPlayer: null },
    { type: 'setScoreLimit', value: 0, byPlayer: null },
  ]);
  join(room, 1, Team.red);
  join(room, 2, Team.red);
  join(room, 3, Team.blue);
  join(room, 4, Team.blue);
  send(room, [{ type: 'startGame', byPlayer: null }]);
  return room;
}

/** Runs the scripted bot match; the browser e2e compares this hash across engines. */
export function runBotMatch(ticks: number): { hash: number; outcomes: TickOutcome[] } {
  const room = setup();
  const rand = prng(42);
  const outcomes: TickOutcome[] = [];
  for (let t = 0; t < ticks; t++) {
    send(room, botEvents(room, t, rand));
    outcomes.push(...stepRoom(room));
  }
  return { hash: hashRoom(room), outcomes };
}
