import { defaultStadiums } from '../stadiums/index.ts';
import { InputFlags, PLAYER_PHYSICS_KEYS, Team, type Disc, type DiscProperties, type GameState, type JointEnd, type PlayerPhysics, type PlayerPhysicsOverrides, type RoomEvent, type RoomPlayer, type RoomState, type SimPlayer } from '../types.ts';
import { assignMidGameDisc, cloneDisc, getStadium, physicsFor, resetPositions } from './players.ts';
import type { TickOutcome } from './step.ts';

export function createRoomState(init: { name: string; maxPlayers: number; hasPassword: boolean }): RoomState {
  return {
    name: init.name,
    maxPlayers: init.maxPlayers,
    hasPassword: init.hasPassword,
    players: [],
    teamsLock: false,
    scoreLimit: 3,
    timeLimit: 3,
    redColors: { angle: 0, textColor: 0xffffff, colors: [] },
    blueColors: { angle: 0, textColor: 0xffffff, colors: [] },
    redName: '',
    blueName: '',
    stadiumSource: defaultStadiums[0].source,
    kickRateLimit: { min: 2, rate: 0, burst: 0 },
    actionKeys: false,
    hud: [],
    camera: { follow: null, zoom: 1 },
    game: null,
  };
}

/** The input bits players may send in this room: the original's five, plus the action keys once the host turns them on. */
export function inputMask(room: RoomState): number {
  return room.actionKeys ? 2047 : 31;
}

function simPlayer(p: RoomPlayer): SimPlayer {
  return { id: p.id, team: p.team, input: 0, kicking: false, kickCooldown: 0, kickTokens: 0, disc: null };
}

function orderLikeRoom(room: RoomState, game: GameState): void {
  game.players = room.players.map((rp) => {
    const sim = game.players.find((p) => p.id === rp.id);
    if (sim === undefined) throw new Error(`player ${rp.id} has no simulation entry`);
    return sim;
  });
}

function startGame(room: RoomState): GameState {
  const stadium = getStadium(room.stadiumSource);
  const game: GameState = {
    tick: 0,
    phase: 'kickoff',
    phaseTicks: 0,
    pauseCounter: 0,
    red: 0,
    blue: 0,
    time: 0,
    overtime: false,
    kickoffTeam: Team.red,
    scoringTeam: null,
    winner: null,
    scoreLimit: room.scoreLimit,
    timeLimit: room.timeLimit,
    stadium,
    discs: stadium.discs.map(cloneDisc),
    players: room.players.map(simPlayer),
    joints: stadium.joints.map(({ d0, d1, ...rest }) => ({ ...rest, a: { disc: d0 }, b: { disc: d1 } })),
  };
  resetPositions(room, game);
  return game;
}

function applyDiscProperties(d: Disc, p: DiscProperties): void {
  if (p.x !== null) d.pos.x = p.x;
  if (p.y !== null) d.pos.y = p.y;
  if (p.xspeed !== null) d.speed.x = p.xspeed;
  if (p.yspeed !== null) d.speed.y = p.yspeed;
  if (p.xgravity !== null) d.gravity.x = p.xgravity;
  if (p.ygravity !== null) d.gravity.y = p.ygravity;
  if (p.radius !== null) d.radius = p.radius;
  if (p.bCoeff !== null) d.bCoef = p.bCoeff;
  if (p.invMass !== null) d.invMass = p.invMass;
  if (p.damping !== null) d.damping = p.damping;
  if (p.color !== null) d.color = p.color;
  if (p.cMask !== null) d.cMask = p.cMask;
  if (p.cGroup !== null) d.cGroup = p.cGroup;
}

function endDisc(game: GameState, end: JointEnd): Disc | null {
  if ('disc' in end) return game.discs[end.disc] ?? null;
  return game.players.find((p) => p.id === end.player)?.disc ?? null;
}

/** The disc fields follow a physics change at once; the movement fields are read every step. */
function applyPhysicsToDisc(d: Disc, pp: PlayerPhysics): void {
  d.radius = pp.radius;
  d.bCoef = pp.bCoef;
  d.invMass = pp.invMass;
  d.damping = pp.damping;
}

/** Returns outcomes only for consequences the event itself does not name (a stopped game reports gameStop). */
export function applyEvent(room: RoomState, ev: RoomEvent): TickOutcome[] {
  const game = room.game;
  switch (ev.type) {
    case 'input': {
      const sim = game?.players.find((p) => p.id === ev.playerId);
      if (sim === undefined) break;
      if ((ev.input & InputFlags.kick) !== 0 && (sim.input & InputFlags.kick) === 0) sim.kicking = true;
      sim.input = ev.input;
      break;
    }
    case 'playerJoin':
      room.players.push({ ...ev.player });
      if (game !== null) {
        const sim = simPlayer(ev.player);
        assignMidGameDisc(game, sim, ev.player.physics);
        game.players.push(sim);
      }
      break;
    case 'playerLeave':
      room.players = room.players.filter((p) => p.id !== ev.playerId);
      if (game !== null) game.players = game.players.filter((p) => p.id !== ev.playerId);
      break;
    case 'setTeam': {
      const rp = room.players.find((p) => p.id === ev.playerId);
      if (rp === undefined || rp.team === ev.team) break;
      rp.team = ev.team;
      room.players = [...room.players.filter((p) => p !== rp), rp];
      const sim = game?.players.find((p) => p.id === ev.playerId);
      if (game !== null && sim !== undefined) {
        sim.team = ev.team;
        assignMidGameDisc(game, sim, rp.physics);
        orderLikeRoom(room, game);
      }
      break;
    }
    case 'setAdmin': {
      const rp = room.players.find((p) => p.id === ev.playerId);
      if (rp !== undefined) rp.admin = ev.admin;
      break;
    }
    case 'setAvatar': {
      const rp = room.players.find((p) => p.id === ev.playerId);
      if (rp !== undefined) rp.avatar = ev.avatar;
      break;
    }
    case 'reorderPlayers': {
      const moved = ev.playerIds.flatMap((id) => room.players.filter((p) => p.id === id));
      const rest = room.players.filter((p) => !moved.includes(p));
      room.players = ev.moveToTop ? [...moved, ...rest] : [...rest, ...moved];
      if (game !== null) orderLikeRoom(room, game);
      break;
    }
    case 'startGame':
      if (game === null) room.game = startGame(room);
      break;
    case 'stopGame':
      if (game === null) break;
      room.game = null;
      return [{ type: 'gameStop' }];
    case 'setPaused':
      if (game === null) break;
      if (ev.paused) game.pauseCounter = 120;
      else if (game.pauseCounter === 120) game.pauseCounter = 119;
      break;
    case 'setStadium':
      if (game === null) room.stadiumSource = ev.source;
      break;
    case 'setScoreLimit':
      if (game === null) room.scoreLimit = ev.value;
      break;
    case 'setTimeLimit':
      if (game === null) room.timeLimit = ev.value;
      break;
    case 'setTeamsLock':
      room.teamsLock = ev.locked;
      break;
    case 'setTeamColors':
      if (ev.team === Team.red) room.redColors = { ...ev.colors, colors: [...ev.colors.colors] };
      else room.blueColors = { ...ev.colors, colors: [...ev.colors.colors] };
      break;
    case 'setKickRateLimit':
      room.kickRateLimit = { ...ev.limit };
      break;
    case 'setPlayerColors': {
      const player = room.players.find((p) => p.id === ev.playerId);
      if (player === undefined) break;
      if (ev.colors === null) delete player.colors;
      else player.colors = { ...ev.colors, colors: [...ev.colors.colors] };
      break;
    }
    case 'setPlayerPhysics': {
      const player = room.players.find((p) => p.id === ev.playerId);
      if (player === undefined) break;
      const physics: PlayerPhysicsOverrides = {};
      for (const k of PLAYER_PHYSICS_KEYS) if (ev.physics?.[k] !== undefined) physics[k] = ev.physics[k];
      if (Object.keys(physics).length === 0) delete player.physics;
      else player.physics = physics;
      const disc = game?.players.find((p) => p.id === ev.playerId)?.disc;
      if (disc) applyPhysicsToDisc(disc, physicsFor(game!.stadium, player.physics));
      break;
    }
    case 'setHudItem': {
      const at = room.hud.findIndex((h) => h.id === ev.id);
      const item = ev.item === null ? null : { id: ev.id, ...ev.item };
      // New arrays, never edits in place: predicted and confirmed copies of the room share the old one.
      if (item === null) room.hud = room.hud.filter((h) => h.id !== ev.id);
      else if (at < 0) room.hud = [...room.hud, item];
      else room.hud = room.hud.map((h, i) => (i === at ? item : h));
      break;
    }
    case 'setCamera':
      room.camera = { follow: ev.camera.follow === null ? null : { ...ev.camera.follow }, zoom: ev.camera.zoom };
      break;
    case 'setActionKeys':
      room.actionKeys = ev.enabled;
      break;
    case 'setDiscProperties': {
      const d = game?.discs[ev.discIndex];
      if (d !== undefined) applyDiscProperties(d, ev.props);
      break;
    }
    case 'setPlayerDiscProperties': {
      const d = game?.players.find((p) => p.id === ev.playerId)?.disc;
      if (d) applyDiscProperties(d, ev.props);
      break;
    }
    case 'addJoint': {
      if (game === null) break;
      const { length, ...joint } = ev.joint;
      let range = length;
      if (range === null) {
        const a = endDisc(game, joint.a);
        const b = endDisc(game, joint.b);
        if (a === null || b === null) break;
        const dx = a.pos.x - b.pos.x;
        const dy = a.pos.y - b.pos.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        range = [d, d];
      }
      game.joints = [...game.joints, { ...joint, a: { ...joint.a }, b: { ...joint.b }, minLength: range[0], maxLength: range[1] }];
      break;
    }
    case 'removeJoint':
      if (game !== null) game.joints = game.joints.filter((_, i) => i !== ev.index);
      break;
    case 'setRoomProps':
      if (ev.name !== null) room.name = ev.name;
      if (ev.maxPlayers !== null) room.maxPlayers = ev.maxPlayers;
      break;
    case 'setTeamName':
      if (ev.team === Team.red) room.redName = ev.name;
      else room.blueName = ev.name;
      break;
    case 'setGameProps':
      if (game === null) break;
      if (ev.red !== null) game.red = ev.red;
      if (ev.blue !== null) game.blue = ev.blue;
      if (ev.time !== null) game.time = ev.time;
      if (ev.scoreLimit !== null) game.scoreLimit = ev.scoreLimit;
      if (ev.timeLimit !== null) game.timeLimit = ev.timeLimit;
      break;
    case 'setPassword':
      room.hasPassword = ev.hasPassword;
      break;
    case 'ping':
      for (const [id, ms] of ev.pings) {
        const rp = room.players.find((p) => p.id === id);
        if (rp !== undefined) rp.ping = ms;
      }
      break;
    case 'chat':
    case 'announcement':
    case 'setTyping':
    case 'syncChange':
      break;
  }
  return [];
}
