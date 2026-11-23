import { Team, type RoomEvent, type RoomState } from '@golix/shared';
import { teamName } from '../render/hud.ts';
import { isDefaultStadium, stadiumChecksum, stadiumName } from './stadiums.ts';

export const TEAM_NAMES: Readonly<Record<Team, string>> = {
  [Team.spectators]: 'Spectators',
  [Team.red]: 'Red',
  [Team.blue]: 'Blue',
};

function by(nameOf: (id: number) => string, byPlayer: number | null): string {
  return byPlayer === null ? '' : ` by ${nameOf(byPlayer)}`;
}

/** The host's team name, or the default one; spectators keep theirs. */
export function anyTeamName(room: Pick<RoomState, 'redName' | 'blueName'>, team: Team): string {
  return team === Team.spectators ? TEAM_NAMES[team] : teamName(room, team);
}

/** System notice text for an applied event, or null when the event leaves no line in the chat log. */
export function describeEvent(ev: RoomEvent, nameOf: (id: number) => string, room: Pick<RoomState, 'redName' | 'blueName'>): string | null {
  switch (ev.type) {
    case 'playerJoin':
      return `${ev.player.name} has joined`;
    case 'playerLeave': {
      const name = nameOf(ev.playerId);
      if (!ev.kicked) return `${name} has left`;
      const reason = ev.reason === '' ? '' : ` (${ev.reason})`;
      return `${name} was ${ev.ban ? 'banned' : 'kicked'}${by(nameOf, ev.byPlayer)}${reason}`;
    }
    case 'setAdmin':
      return ev.admin ? `${nameOf(ev.playerId)} was given admin rights` : `${nameOf(ev.playerId)}'s admin rights were taken away`;
    case 'setTeam':
      if (!ev.announce) return null;
      return `${nameOf(ev.playerId)} was moved to ${anyTeamName(room, ev.team)}${by(nameOf, ev.byPlayer)}`;
    case 'startGame':
      return `Game started${by(nameOf, ev.byPlayer)}`;
    case 'stopGame':
      return ev.byPlayer === null ? null : `Game stopped by ${nameOf(ev.byPlayer)}`;
    case 'setPaused':
      return ev.paused ? `Game paused${by(nameOf, ev.byPlayer)}` : null;
    case 'setStadium':
      if (isDefaultStadium(ev.source)) return null;
      return `Stadium "${stadiumName(ev.source)}" (${stadiumChecksum(ev.source)}) loaded${by(nameOf, ev.byPlayer)}`;
    case 'setKickRateLimit': {
      const { min, rate, burst } = ev.limit;
      return `Kick Rate Limit set to (min: ${min}, rate: ${rate}, burst: ${burst})${by(nameOf, ev.byPlayer)}`;
    }
    case 'syncChange':
      return `${nameOf(ev.playerId)} ${ev.synced ? 'is back in sync' : 'has desynchronized'}`;
    default:
      return null;
  }
}
