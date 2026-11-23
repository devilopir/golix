import JSON5 from 'json5';
import { applyEvent, createRoomState, stepRoom, type TickOutcome } from '../../src/game/index.ts';
import { defaultStadiums } from '../../src/stadiums/index.ts';
import { Team, type DiscProperties, type GameState, type RoomEvent, type RoomState } from '../../src/types.ts';

export function newRoom(): RoomState {
  return createRoomState({ name: 'test', maxPlayers: 12, hasPassword: false });
}

export function join(room: RoomState, id: number, team: Team = Team.spectators): void {
  applyEvent(room, {
    type: 'playerJoin',
    player: { id, name: `p${id}`, team: Team.spectators, admin: false, avatar: '', country: 'tr', joinSeq: id, ping: 0 },
  });
  if (team !== Team.spectators) applyEvent(room, { type: 'setTeam', playerId: id, team, byPlayer: null, announce: false });
}

export function game(room: RoomState): GameState {
  if (room.game === null) throw new Error('no game running');
  return room.game;
}

export function props(p: Partial<DiscProperties>): DiscProperties {
  return { x: null, y: null, xspeed: null, yspeed: null, xgravity: null, ygravity: null, radius: null, bCoeff: null, invMass: null, damping: null, color: null, cMask: null, cGroup: null, ...p };
}

export function setBall(room: RoomState, p: Partial<DiscProperties>): void {
  applyEvent(room, { type: 'setDiscProperties', discIndex: 0, props: props(p) });
}

export function step(room: RoomState, ticks = 1): TickOutcome[] {
  const out: TickOutcome[] = [];
  for (let i = 0; i < ticks; i++) out.push(...stepRoom(room));
  return out;
}

export function stepUntil(room: RoomState, type: TickOutcome['type'], max = 20000): { ticks: number; outcome: TickOutcome } {
  for (let i = 1; i <= max; i++) {
    const outcome = stepRoom(room).find((o) => o.type === type);
    if (outcome !== undefined) return { ticks: i, outcome };
  }
  throw new Error(`no ${type} within ${max} ticks`);
}

/** Sends the ball into the goal that `conceding` defends; the game must be in kickoff or playing. */
export function score(room: RoomState, conceding: typeof Team.red | typeof Team.blue): TickOutcome {
  const goal = game(room).stadium.goals.find((g) => g.team === conceding);
  if (goal === undefined) throw new Error('no goal');
  const dir = goal.p0.x < 0 ? -1 : 1;
  setBall(room, { x: goal.p0.x - dir * 20, y: 0, xspeed: dir * 6, yspeed: 0 });
  return stepUntil(room, 'goal', 60).outcome;
}

export function customStadium(edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON5.parse(defaultStadiums[0].source) as Record<string, unknown>;
  edit(raw);
  return JSON5.stringify(raw);
}

export function send(room: RoomState, events: RoomEvent[]): void {
  for (const ev of events) applyEvent(room, ev);
}
