import { Team, type RoomPlayer, type RoomState } from '@golix/shared';

export interface TeamMove {
  playerId: number;
  team: Team;
}

export function selfPlayer(room: RoomState, playerId: number): RoomPlayer | undefined {
  return room.players.find((p) => p.id === playerId);
}

export function isAdmin(room: RoomState, playerId: number): boolean {
  return selfPlayer(room, playerId)?.admin ?? false;
}

/** Joining a team yourself works only between matches, and only for admins while teams are locked. */
export function canSelfMove(room: RoomState, playerId: number): boolean {
  return room.game === null && (!room.teamsLock || isAdmin(room, playerId));
}

function onTeam(room: RoomState, team: Team): RoomPlayer[] {
  return room.players.filter((p) => p.team === team);
}

/** Shuffles every player, spectators included, and deals them out alternately to Red and Blue. */
export function randomizeTeams(room: RoomState, random: () => number): TeamMove[] {
  const playing = [...room.players];
  for (let i = playing.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [playing[i], playing[j]] = [playing[j], playing[i]];
  }
  return playing
    .map((p, i) => ({ playerId: p.id, team: i % 2 === 0 ? Team.red : Team.blue, from: p.team }))
    .filter((m) => m.team !== m.from)
    .map(({ playerId, team }) => ({ playerId, team }));
}

/** Fills the smaller team from the top of the spectator list; with equal teams, adds one player to each. */
export function autoAssign(room: RoomState): TeamMove[] {
  const spectators = onTeam(room, Team.spectators);
  const red = onTeam(room, Team.red).length;
  const blue = onTeam(room, Team.blue).length;
  if (red !== blue) return spectators.length === 0 ? [] : [{ playerId: spectators[0].id, team: red < blue ? Team.red : Team.blue }];
  if (spectators.length < 2) return [];
  return [
    { playerId: spectators[0].id, team: Team.red },
    { playerId: spectators[1].id, team: Team.blue },
  ];
}

export function moveAllToSpectators(room: RoomState, team: Team | null = null): TeamMove[] {
  return room.players
    .filter((p) => p.team !== Team.spectators && (team === null || p.team === team))
    .map((p) => ({ playerId: p.id, team: Team.spectators }));
}
