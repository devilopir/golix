import { fileURLToPath } from 'node:url';
import { HBInit, type PlayerObject, type RoomObject, type TeamID } from '@golix/headless';

const RED = 1;
const BLUE = 2;

interface Stats {
  name: string;
  goals: number;
  assists: number;
  kicks: number;
  ownGoals: number;
}

/** Keeps red and blue within one player of each other and announces per-player stats when a match ends. */
export function balanceStats(room: RoomObject): void {
  // Our own view of the teams: setPlayerTeam only lands on the next tick.
  const teams = new Map<number, TeamID>();
  const stats = new Map<number, Stats>();
  let touches: { id: number; team: TeamID }[] = [];

  const count = (team: TeamID) => [...teams.values()].filter((t) => t === team).length;
  const move = (id: number, team: TeamID) => {
    teams.set(id, team);
    room.setPlayerTeam(id, team);
  };
  const statsOf = (player: PlayerObject) => {
    let s = stats.get(player.id);
    if (s === undefined) stats.set(player.id, (s = { name: player.name, goals: 0, assists: 0, kicks: 0, ownGoals: 0 }));
    return s;
  };

  room.onPlayerJoin = (player) => {
    move(player.id, count(RED) <= count(BLUE) ? RED : BLUE);
  };

  room.onPlayerLeave = (player) => {
    teams.delete(player.id);
    const red = count(RED);
    const blue = count(BLUE);
    if (Math.abs(red - blue) < 2) return;
    const from = red > blue ? RED : BLUE;
    const last = [...teams].reverse().find(([, t]) => t === from);
    if (last !== undefined) move(last[0], from === RED ? BLUE : RED);
  };

  room.onPlayerTeamChange = (player) => {
    teams.set(player.id, player.team);
  };

  room.onGameStart = () => {
    stats.clear();
    touches = [];
  };

  room.onPositionsReset = () => {
    touches = [];
  };

  room.onPlayerBallKick = (player) => {
    statsOf(player).kicks++;
    touches = [{ id: player.id, team: player.team }, ...touches.filter((t) => t.id !== player.id)];
  };

  room.onTeamGoal = (team) => {
    const [scorer, previous] = touches;
    if (scorer === undefined) return;
    const s = stats.get(scorer.id);
    if (s === undefined) return;
    if (scorer.team !== team) {
      s.ownGoals++;
      return;
    }
    s.goals++;
    if (previous?.team === team) {
      const a = stats.get(previous.id);
      if (a !== undefined) a.assists++;
    }
  };

  room.onTeamVictory = (scores) => {
    room.sendAnnouncement(`${scores.red > scores.blue ? 'Red' : 'Blue'} wins ${scores.red}-${scores.blue}`, null, 0xffff00, 'bold');
    for (const s of stats.values()) {
      room.sendAnnouncement(`${s.name}: ${s.goals} goals, ${s.assists} assists, ${s.kicks} kicks, ${s.ownGoals} own goals`, null, null, 'small');
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const room = HBInit({ roomName: 'Balanced', noPlayer: true, public: true });
  balanceStats(room);
  room.onRoomLink = (url) => console.log(`Room link: ${url}`);
}
