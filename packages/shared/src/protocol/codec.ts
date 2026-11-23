import { getStadium } from '../game/index.ts';
import { PLAYER_PHYSICS_KEYS } from '../types.ts';
import type {
  CameraOverride,
  ClientMessage,
  HudItem,
  Disc,
  GameJoint,
  JointEnd,
  DiscProperties,
  GamePhase,
  GameState,
  KickRateLimit,
  PlayerPhysicsOverrides,
  PlayingTeam,
  RoomEvent,
  RoomPlayer,
  RoomState,
  ServerMessage,
  SimPlayer,
  Team,
  TeamColors,
} from '../types.ts';
import { ProtocolError, Reader, Writer } from './wire.ts';

/** Maximum lengths in Unicode code points. */
export const LIMITS = {
  chat: 140,
  announcement: 1000,
  name: 25,
  avatar: 2,
  password: 30,
  roomName: 40,
  country: 2,
  auth: 100,
  reason: 100,
  stadium: 1_000_000,
  teamColors: 5,
  hudId: 20,
  hudText: 100,
  hudItems: 16,
  verified: 120,
  teamName: 20,
} as const;

const EVENT_TYPES = [
  'input',
  'playerJoin',
  'playerLeave',
  'chat',
  'announcement',
  'setTeam',
  'setAdmin',
  'setAvatar',
  'reorderPlayers',
  'startGame',
  'stopGame',
  'setPaused',
  'setStadium',
  'setScoreLimit',
  'setTimeLimit',
  'setTeamsLock',
  'setTeamColors',
  'setKickRateLimit',
  'setDiscProperties',
  'setPlayerDiscProperties',
  'setPassword',
  'setTyping',
  'ping',
  'syncChange',
  'setPlayerColors',
  'setActionKeys',
  'setPlayerPhysics',
  'setHudItem',
  'setCamera',
  'addJoint',
  'removeJoint',
  'setRoomProps',
  'setTeamName',
  'setGameProps',
] as const satisfies readonly RoomEvent['type'][];

const HUD_ALIGNS = ['left', 'center', 'right'] as const satisfies readonly HudItem['align'][];

const STYLES = ['normal', 'bold', 'italic', 'small', 'small-bold', 'small-italic'] as const;
const PHASES = ['kickoff', 'playing', 'goal', 'ended'] as const satisfies readonly GamePhase[];
const REJECT_REASONS = ['password', 'full', 'banned', 'invalid', 'rateLimited', 'captcha', 'connLimit', 'version'] as const;

/**
 * Bumped whenever the engine or the wire format changes, so mismatched peers refuse each other at the join instead of
 * desyncing. A join starts with its type byte and this number, a prefix that must never change.
 */
export const PROTOCOL_VERSION = 3;
const CLIENT_TYPES = ['join', 'input', 'request', 'chat', 'pong', 'setPassword', 'clearBans', 'resync'] as const satisfies readonly ClientMessage['type'][];
const SERVER_TYPES = ['challenge', 'welcome', 'joinRejected', 'events', 'hash', 'snapshot', 'ping', 'disconnected'] as const satisfies readonly ServerMessage['type'][];

function pick<T>(table: readonly T[], i: number, what: string): T {
  const v = table[i];
  if (v === undefined) throw new ProtocolError(`unknown ${what} ${i}`);
  return v;
}

function readTeam(r: Reader): Team {
  const t = r.u8();
  if (t > 2) throw new ProtocolError(`invalid team ${t}`);
  return t as Team;
}

function readPlayingTeam(r: Reader): PlayingTeam {
  const t = readTeam(r);
  if (t === 0) throw new ProtocolError('expected red or blue');
  return t;
}

function writeOptTeam(w: Writer, t: PlayingTeam | null): void {
  w.u8(t ?? 0);
}

function readOptTeam(r: Reader): PlayingTeam | null {
  const t = readTeam(r);
  return t === 0 ? null : t;
}

function writeOptId(w: Writer, id: number | null): void {
  w.uint(id === null ? 0 : id + 1);
}

function readOptId(r: Reader): number | null {
  const v = r.uint();
  return v === 0 ? null : v - 1;
}

function writePlayer(w: Writer, p: RoomPlayer): void {
  w.uint(p.id);
  w.str(p.name, LIMITS.name);
  w.u8(p.team);
  w.bool(p.admin);
  w.str(p.avatar, LIMITS.avatar);
  w.str(p.country, LIMITS.country);
  w.uint(p.joinSeq);
  w.uint(p.ping);
  w.bool(p.colors !== undefined);
  if (p.colors !== undefined) writeColors(w, p.colors);
  writePhysics(w, p.physics ?? null);
}

/** A field mask, then the set fields; mask 0 is null. */
function writePhysics(w: Writer, physics: PlayerPhysicsOverrides | null): void {
  let mask = 0;
  PLAYER_PHYSICS_KEYS.forEach((k, i) => {
    if (physics?.[k] !== undefined) mask |= 1 << i;
  });
  w.uint(mask);
  for (const k of PLAYER_PHYSICS_KEYS) {
    const v = physics?.[k];
    if (v !== undefined) w.f64(v);
  }
}

function writeHudFields(w: Writer, item: Omit<HudItem, 'id'>): void {
  w.str(item.text, LIMITS.hudText);
  w.f64(item.x);
  w.f64(item.y);
  w.u8(HUD_ALIGNS.indexOf(item.align));
  w.int(item.color);
  w.uint(item.size);
}

function readHudFields(r: Reader): Omit<HudItem, 'id'> {
  return { text: r.str(LIMITS.hudText), x: r.f64(), y: r.f64(), align: pick(HUD_ALIGNS, r.u8(), 'hud align'), color: r.int(), size: r.uint() };
}

/** 0: no follow, 1: player, 2: disc, 3: point. */
function writeCamera(w: Writer, c: CameraOverride): void {
  const f = c.follow;
  if (f === null) w.u8(0);
  else if (f.type === 'player') {
    w.u8(1);
    w.uint(f.id);
  } else if (f.type === 'disc') {
    w.u8(2);
    w.uint(f.index);
  } else {
    w.u8(3);
    w.f64(f.x);
    w.f64(f.y);
  }
  w.f64(c.zoom);
}

function readCamera(r: Reader): CameraOverride {
  const kind = r.u8();
  let follow: CameraOverride['follow'];
  if (kind === 0) follow = null;
  else if (kind === 1) follow = { type: 'player', id: r.uint() };
  else if (kind === 2) follow = { type: 'disc', index: r.uint() };
  else if (kind === 3) follow = { type: 'point', x: r.f64(), y: r.f64() };
  else throw new ProtocolError(`invalid camera follow ${kind}`);
  return { follow, zoom: r.f64() };
}

function writeJointEnd(w: Writer, end: JointEnd): void {
  w.bool('player' in end);
  w.uint('player' in end ? end.player : end.disc);
}

function readJointEnd(r: Reader): JointEnd {
  return r.bool() ? { player: r.uint() } : { disc: r.uint() };
}

function writeJointFields(w: Writer, j: Omit<GameJoint, 'minLength' | 'maxLength'>): void {
  writeJointEnd(w, j.a);
  writeJointEnd(w, j.b);
  w.f64(j.strength);
  w.int(j.color);
  w.f64(j.breakLength);
}

function readJointFields(r: Reader): Omit<GameJoint, 'minLength' | 'maxLength'> {
  return { a: readJointEnd(r), b: readJointEnd(r), strength: r.f64(), color: r.int(), breakLength: r.f64() };
}

function readPhysics(r: Reader): PlayerPhysicsOverrides | null {
  const mask = r.uint();
  if (mask >= 1 << PLAYER_PHYSICS_KEYS.length) throw new ProtocolError('invalid player physics mask');
  if (mask === 0) return null;
  const physics: PlayerPhysicsOverrides = {};
  PLAYER_PHYSICS_KEYS.forEach((k, i) => {
    if ((mask & (1 << i)) !== 0) physics[k] = r.f64();
  });
  return physics;
}

function readPlayer(r: Reader): RoomPlayer {
  const player: RoomPlayer = {
    id: r.uint(),
    name: r.str(LIMITS.name),
    team: readTeam(r),
    admin: r.bool(),
    avatar: r.str(LIMITS.avatar),
    country: r.str(LIMITS.country),
    joinSeq: r.uint(),
    ping: r.uint(),
  };
  if (r.bool()) player.colors = readColors(r);
  const physics = readPhysics(r);
  if (physics !== null) player.physics = physics;
  return player;
}

function writeColors(w: Writer, c: TeamColors): void {
  w.f64(c.angle);
  w.int(c.textColor);
  if (c.colors.length > LIMITS.teamColors) throw new ProtocolError(`at most ${LIMITS.teamColors} team colors`);
  w.u8(c.colors.length);
  for (const v of c.colors) w.int(v);
}

function readColors(r: Reader): TeamColors {
  const angle = r.f64();
  const textColor = r.int();
  const n = r.u8();
  if (n > LIMITS.teamColors) throw new ProtocolError(`at most ${LIMITS.teamColors} team colors`);
  const colors: number[] = [];
  for (let i = 0; i < n; i++) colors.push(r.int());
  return { angle, textColor, colors };
}

function writeKickRateLimit(w: Writer, l: KickRateLimit): void {
  w.uint(l.min);
  w.uint(l.rate);
  w.uint(l.burst);
}

function readKickRateLimit(r: Reader): KickRateLimit {
  return { min: r.uint(), rate: r.uint(), burst: r.uint() };
}

const PROP_FLOATS = ['x', 'y', 'xspeed', 'yspeed', 'xgravity', 'ygravity', 'radius', 'bCoeff', 'invMass', 'damping'] as const;
const PROP_INTS = ['color', 'cMask', 'cGroup'] as const;

function writeProps(w: Writer, p: DiscProperties): void {
  const keys = [...PROP_FLOATS, ...PROP_INTS];
  let mask = 0;
  keys.forEach((k, i) => {
    if (p[k] !== null) mask |= 1 << i;
  });
  w.uint(mask);
  for (const k of PROP_FLOATS) {
    const v = p[k];
    if (v !== null) w.f64(v);
  }
  for (const k of PROP_INTS) {
    const v = p[k];
    if (v !== null) w.int(v);
  }
}

function readProps(r: Reader): DiscProperties {
  const mask = r.uint();
  if (mask >= 1 << (PROP_FLOATS.length + PROP_INTS.length)) throw new ProtocolError('invalid disc property mask');
  const p = {} as DiscProperties;
  PROP_FLOATS.forEach((k, i) => {
    p[k] = (mask & (1 << i)) !== 0 ? r.f64() : null;
  });
  PROP_INTS.forEach((k, i) => {
    p[k] = (mask & (1 << (PROP_FLOATS.length + i))) !== 0 ? r.int() : null;
  });
  return p;
}

export function writeEvent(w: Writer, ev: RoomEvent): void {
  w.u8(EVENT_TYPES.indexOf(ev.type));
  switch (ev.type) {
    case 'input':
      w.uint(ev.playerId);
      w.uint(ev.input);
      break;
    case 'playerJoin':
      writePlayer(w, ev.player);
      break;
    case 'playerLeave':
      w.uint(ev.playerId);
      w.bool(ev.kicked);
      w.bool(ev.ban);
      w.str(ev.reason, LIMITS.reason);
      writeOptId(w, ev.byPlayer);
      break;
    case 'chat':
      w.uint(ev.playerId);
      w.str(ev.text, LIMITS.chat);
      break;
    case 'announcement':
      w.str(ev.text, LIMITS.announcement);
      writeOptId(w, ev.targetId);
      w.int(ev.color);
      w.u8(STYLES.indexOf(ev.style));
      w.u8(ev.sound);
      break;
    case 'setTeam':
      w.uint(ev.playerId);
      w.u8(ev.team);
      writeOptId(w, ev.byPlayer);
      w.bool(ev.announce);
      break;
    case 'setAdmin':
      w.uint(ev.playerId);
      w.bool(ev.admin);
      writeOptId(w, ev.byPlayer);
      break;
    case 'setAvatar':
      w.uint(ev.playerId);
      w.str(ev.avatar, LIMITS.avatar);
      break;
    case 'reorderPlayers':
      w.uint(ev.playerIds.length);
      for (const id of ev.playerIds) w.uint(id);
      w.bool(ev.moveToTop);
      break;
    case 'startGame':
    case 'stopGame':
      writeOptId(w, ev.byPlayer);
      break;
    case 'setPaused':
      w.bool(ev.paused);
      writeOptId(w, ev.byPlayer);
      break;
    case 'setStadium':
      w.str(ev.source, LIMITS.stadium);
      writeOptId(w, ev.byPlayer);
      break;
    case 'setScoreLimit':
    case 'setTimeLimit':
      w.uint(ev.value);
      writeOptId(w, ev.byPlayer);
      break;
    case 'setTeamsLock':
      w.bool(ev.locked);
      writeOptId(w, ev.byPlayer);
      break;
    case 'setTeamColors':
      w.u8(ev.team);
      writeColors(w, ev.colors);
      writeOptId(w, ev.byPlayer);
      break;
    case 'setKickRateLimit':
      writeKickRateLimit(w, ev.limit);
      writeOptId(w, ev.byPlayer);
      break;
    case 'setDiscProperties':
      w.uint(ev.discIndex);
      writeProps(w, ev.props);
      break;
    case 'setPlayerDiscProperties':
      w.uint(ev.playerId);
      writeProps(w, ev.props);
      break;
    case 'setPassword':
      w.bool(ev.hasPassword);
      writeOptId(w, ev.byPlayer);
      break;
    case 'setTyping':
      w.uint(ev.playerId);
      w.bool(ev.typing);
      break;
    case 'ping':
      w.uint(ev.pings.length);
      for (const [id, ms] of ev.pings) {
        w.uint(id);
        w.uint(ms);
      }
      break;
    case 'syncChange':
      w.uint(ev.playerId);
      w.bool(ev.synced);
      break;
    case 'setPlayerColors':
      w.uint(ev.playerId);
      w.bool(ev.colors !== null);
      if (ev.colors !== null) writeColors(w, ev.colors);
      break;
    case 'setActionKeys':
      w.bool(ev.enabled);
      break;
    case 'setPlayerPhysics':
      w.uint(ev.playerId);
      writePhysics(w, ev.physics);
      break;
    case 'setHudItem':
      w.str(ev.id, LIMITS.hudId);
      w.bool(ev.item !== null);
      if (ev.item !== null) writeHudFields(w, ev.item);
      break;
    case 'setCamera':
      writeCamera(w, ev.camera);
      break;
    case 'addJoint':
      writeJointFields(w, ev.joint);
      w.bool(ev.joint.length !== null);
      if (ev.joint.length !== null) {
        w.f64(ev.joint.length[0]);
        w.f64(ev.joint.length[1]);
      }
      break;
    case 'removeJoint':
      w.uint(ev.index);
      break;
    case 'setRoomProps':
      w.bool(ev.name !== null);
      if (ev.name !== null) w.str(ev.name, LIMITS.roomName);
      writeOptId(w, ev.maxPlayers);
      break;
    case 'setTeamName':
      w.u8(ev.team);
      w.str(ev.name, LIMITS.teamName);
      break;
    case 'setGameProps':
      for (const v of [ev.red, ev.blue, ev.scoreLimit, ev.timeLimit]) writeOptId(w, v);
      w.bool(ev.time !== null);
      if (ev.time !== null) w.f64(ev.time);
      break;
  }
}

export function readEvent(r: Reader): RoomEvent {
  const type = pick(EVENT_TYPES, r.u8(), 'event type');
  switch (type) {
    case 'input':
      return { type, playerId: r.uint(), input: r.uint() };
    case 'playerJoin':
      return { type, player: readPlayer(r) };
    case 'playerLeave':
      return { type, playerId: r.uint(), kicked: r.bool(), ban: r.bool(), reason: r.str(LIMITS.reason), byPlayer: readOptId(r) };
    case 'chat':
      return { type, playerId: r.uint(), text: r.str(LIMITS.chat) };
    case 'announcement': {
      const text = r.str(LIMITS.announcement);
      const targetId = readOptId(r);
      const color = r.int();
      const style = pick(STYLES, r.u8(), 'announcement style');
      const sound = r.u8();
      if (sound > 2) throw new ProtocolError(`invalid announcement sound ${sound}`);
      return { type, text, targetId, color, style, sound: sound as 0 | 1 | 2 };
    }
    case 'setTeam':
      return { type, playerId: r.uint(), team: readTeam(r), byPlayer: readOptId(r), announce: r.bool() };
    case 'setAdmin':
      return { type, playerId: r.uint(), admin: r.bool(), byPlayer: readOptId(r) };
    case 'setAvatar':
      return { type, playerId: r.uint(), avatar: r.str(LIMITS.avatar) };
    case 'reorderPlayers': {
      const n = r.count();
      const playerIds: number[] = [];
      for (let i = 0; i < n; i++) playerIds.push(r.uint());
      return { type, playerIds, moveToTop: r.bool() };
    }
    case 'startGame':
    case 'stopGame':
      return { type, byPlayer: readOptId(r) };
    case 'setPaused':
      return { type, paused: r.bool(), byPlayer: readOptId(r) };
    case 'setStadium':
      return { type, source: r.str(LIMITS.stadium), byPlayer: readOptId(r) };
    case 'setScoreLimit':
    case 'setTimeLimit':
      return { type, value: r.uint(), byPlayer: readOptId(r) };
    case 'setTeamsLock':
      return { type, locked: r.bool(), byPlayer: readOptId(r) };
    case 'setTeamColors':
      return { type, team: readPlayingTeam(r), colors: readColors(r), byPlayer: readOptId(r) };
    case 'setKickRateLimit':
      return { type, limit: readKickRateLimit(r), byPlayer: readOptId(r) };
    case 'setDiscProperties':
      return { type, discIndex: r.uint(), props: readProps(r) };
    case 'setPlayerDiscProperties':
      return { type, playerId: r.uint(), props: readProps(r) };
    case 'setPassword':
      return { type, hasPassword: r.bool(), byPlayer: readOptId(r) };
    case 'setTyping':
      return { type, playerId: r.uint(), typing: r.bool() };
    case 'ping': {
      const n = r.count();
      const pings: [number, number][] = [];
      for (let i = 0; i < n; i++) pings.push([r.uint(), r.uint()]);
      return { type, pings };
    }
    case 'syncChange':
      return { type, playerId: r.uint(), synced: r.bool() };
    case 'setPlayerColors':
      return { type, playerId: r.uint(), colors: r.bool() ? readColors(r) : null };
    case 'setActionKeys':
      return { type, enabled: r.bool() };
    case 'setPlayerPhysics':
      return { type, playerId: r.uint(), physics: readPhysics(r) };
    case 'setHudItem': {
      const id = r.str(LIMITS.hudId);
      return { type, id, item: r.bool() ? readHudFields(r) : null };
    }
    case 'setCamera':
      return { type, camera: readCamera(r) };
    case 'addJoint': {
      const fields = readJointFields(r);
      return { type, joint: { ...fields, length: r.bool() ? [r.f64(), r.f64()] : null } };
    }
    case 'removeJoint':
      return { type, index: r.uint() };
    case 'setRoomProps':
      return { type, name: r.bool() ? r.str(LIMITS.roomName) : null, maxPlayers: readOptId(r) };
    case 'setTeamName':
      return { type, team: readPlayingTeam(r), name: r.str(LIMITS.teamName) };
    case 'setGameProps': {
      const [red, blue, scoreLimit, timeLimit] = [readOptId(r), readOptId(r), readOptId(r), readOptId(r)];
      return { type, red, blue, time: r.bool() ? r.f64() : null, scoreLimit, timeLimit };
    }
  }
}

function writeDisc(w: Writer, d: Disc): void {
  for (const v of [d.pos.x, d.pos.y, d.speed.x, d.speed.y, d.gravity.x, d.gravity.y, d.radius, d.invMass, d.damping, d.bCoef]) w.f64(v);
  w.int(d.color);
  w.int(d.cGroup);
  w.int(d.cMask);
}

function readDisc(r: Reader): Disc {
  return {
    pos: { x: r.f64(), y: r.f64() },
    speed: { x: r.f64(), y: r.f64() },
    gravity: { x: r.f64(), y: r.f64() },
    radius: r.f64(),
    invMass: r.f64(),
    damping: r.f64(),
    bCoef: r.f64(),
    color: r.int(),
    cGroup: r.int(),
    cMask: r.int(),
  };
}

function writeSimPlayer(w: Writer, p: SimPlayer): void {
  w.uint(p.id);
  w.u8(p.team);
  w.uint(p.input);
  w.bool(p.kicking);
  w.int(p.kickCooldown);
  w.int(p.kickTokens);
  w.bool(p.disc !== null);
  if (p.disc !== null) writeDisc(w, p.disc);
}

function readSimPlayer(r: Reader): SimPlayer {
  return {
    id: r.uint(),
    team: readTeam(r),
    input: r.uint(),
    kicking: r.bool(),
    kickCooldown: r.int(),
    kickTokens: r.int(),
    disc: r.bool() ? readDisc(r) : null,
  };
}

function writeGame(w: Writer, g: GameState): void {
  w.uint(g.tick);
  w.u8(PHASES.indexOf(g.phase));
  w.uint(g.phaseTicks);
  w.uint(g.pauseCounter);
  w.uint(g.red);
  w.uint(g.blue);
  w.f64(g.time);
  w.bool(g.overtime);
  w.u8(g.kickoffTeam);
  writeOptTeam(w, g.scoringTeam);
  writeOptTeam(w, g.winner);
  w.uint(g.scoreLimit);
  w.uint(g.timeLimit);
  w.uint(g.discs.length);
  for (const d of g.discs) writeDisc(w, d);
  w.uint(g.players.length);
  for (const p of g.players) writeSimPlayer(w, p);
  w.uint(g.joints.length);
  for (const j of g.joints) {
    writeJointFields(w, j);
    w.f64(j.minLength);
    w.f64(j.maxLength);
  }
}

function readGame(r: Reader, stadiumSource: string): GameState {
  const tick = r.uint();
  const phase = pick(PHASES, r.u8(), 'game phase');
  const phaseTicks = r.uint();
  const pauseCounter = r.uint();
  const red = r.uint();
  const blue = r.uint();
  const time = r.f64();
  const overtime = r.bool();
  const kickoffTeam = readPlayingTeam(r);
  const scoringTeam = readOptTeam(r);
  const winner = readOptTeam(r);
  const scoreLimit = r.uint();
  const timeLimit = r.uint();
  const discs: Disc[] = [];
  for (let i = r.count(); i > 0; i--) discs.push(readDisc(r));
  const players: SimPlayer[] = [];
  for (let i = r.count(); i > 0; i--) players.push(readSimPlayer(r));
  const joints: GameJoint[] = [];
  for (let i = r.count(); i > 0; i--) joints.push({ ...readJointFields(r), minLength: r.f64(), maxLength: r.f64() });
  const stadium = getStadium(stadiumSource);
  return { tick, phase, phaseTicks, pauseCounter, red, blue, time, overtime, kickoffTeam, scoringTeam, winner, scoreLimit, timeLimit, stadium, discs, players, joints };
}

export function writeRoom(w: Writer, room: RoomState): void {
  w.str(room.name, LIMITS.roomName);
  w.uint(room.maxPlayers);
  w.bool(room.hasPassword);
  w.uint(room.players.length);
  for (const p of room.players) writePlayer(w, p);
  w.bool(room.teamsLock);
  w.uint(room.scoreLimit);
  w.uint(room.timeLimit);
  writeColors(w, room.redColors);
  writeColors(w, room.blueColors);
  w.str(room.redName, LIMITS.teamName);
  w.str(room.blueName, LIMITS.teamName);
  w.str(room.stadiumSource, LIMITS.stadium);
  writeKickRateLimit(w, room.kickRateLimit);
  w.bool(room.actionKeys);
  if (room.hud.length > LIMITS.hudItems) throw new ProtocolError(`at most ${LIMITS.hudItems} hud items`);
  w.u8(room.hud.length);
  for (const item of room.hud) {
    w.str(item.id, LIMITS.hudId);
    writeHudFields(w, item);
  }
  writeCamera(w, room.camera);
  w.bool(room.game !== null);
  if (room.game !== null) writeGame(w, room.game);
}

/** Rebuilds the parsed stadium from stadiumSource, so it fails if the source does not parse. */
export function readRoom(r: Reader): RoomState {
  const name = r.str(LIMITS.roomName);
  const maxPlayers = r.uint();
  const hasPassword = r.bool();
  const players: RoomPlayer[] = [];
  for (let i = r.count(); i > 0; i--) players.push(readPlayer(r));
  const teamsLock = r.bool();
  const scoreLimit = r.uint();
  const timeLimit = r.uint();
  const redColors = readColors(r);
  const blueColors = readColors(r);
  const redName = r.str(LIMITS.teamName);
  const blueName = r.str(LIMITS.teamName);
  const stadiumSource = r.str(LIMITS.stadium);
  const kickRateLimit = readKickRateLimit(r);
  const actionKeys = r.bool();
  const hudCount = r.u8();
  if (hudCount > LIMITS.hudItems) throw new ProtocolError(`at most ${LIMITS.hudItems} hud items`);
  const hud: HudItem[] = [];
  for (let i = 0; i < hudCount; i++) {
    const id = r.str(LIMITS.hudId);
    hud.push({ id, ...readHudFields(r) });
  }
  const camera = readCamera(r);
  const game = r.bool() ? readGame(r, stadiumSource) : null;
  return { name, maxPlayers, hasPassword, players, teamsLock, scoreLimit, timeLimit, redColors, blueColors, redName, blueName, stadiumSource, kickRateLimit, actionKeys, hud, camera, game };
}

export function encodeClientMessage(msg: ClientMessage): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  w.u8(CLIENT_TYPES.indexOf(msg.type));
  switch (msg.type) {
    case 'join':
      w.uint(PROTOCOL_VERSION);
      w.str(msg.name, LIMITS.name);
      w.str(msg.avatar, LIMITS.avatar);
      w.str(msg.country, LIMITS.country);
      w.str(msg.password, LIMITS.password);
      w.str(msg.auth, LIMITS.auth);
      w.str(msg.signature, LIMITS.auth);
      w.str(msg.verified, LIMITS.verified);
      break;
    case 'input':
      w.uint(msg.tick);
      w.uint(msg.input);
      break;
    case 'request':
      writeEvent(w, msg.event);
      break;
    case 'chat':
      w.str(msg.text, LIMITS.chat);
      break;
    case 'pong':
      w.f64(msg.t);
      break;
    case 'setPassword':
      w.u8(msg.password === null ? 0 : 1);
      if (msg.password !== null) w.str(msg.password, LIMITS.password);
      break;
    case 'clearBans':
    case 'resync':
      break;
  }
  return w.finish();
}

function readClientMessage(r: Reader): ClientMessage {
  const type = pick(CLIENT_TYPES, r.u8(), 'client message');
  switch (type) {
    case 'join':
      if (r.uint() !== PROTOCOL_VERSION) throw new ProtocolError('protocol version');
      return { type, name: r.str(LIMITS.name), avatar: r.str(LIMITS.avatar), country: r.str(LIMITS.country), password: r.str(LIMITS.password), auth: r.str(LIMITS.auth), signature: r.str(LIMITS.auth), verified: r.str(LIMITS.verified) };
    case 'input':
      return { type, tick: r.uint(), input: r.uint() };
    case 'request':
      return { type, event: readEvent(r) };
    case 'chat':
      return { type, text: r.str(LIMITS.chat) };
    case 'pong':
      return { type, t: r.f64() };
    case 'setPassword':
      return { type, password: r.u8() === 0 ? null : r.str(LIMITS.password) };
    case 'clearBans':
    case 'resync':
      return { type };
  }
}

/** The protocol version a join message carries, read from its fixed prefix; null for any other message. */
export function joinVersion(data: Uint8Array | ArrayBuffer): number | null {
  try {
    const r = new Reader(data);
    return r.u8() === CLIENT_TYPES.indexOf('join') ? r.uint() : null;
  } catch {
    return null;
  }
}

export function decodeClientMessage(data: Uint8Array | ArrayBuffer): ClientMessage {
  const r = new Reader(data);
  const msg = readClientMessage(r);
  r.end();
  return msg;
}

export function encodeServerMessage(msg: ServerMessage): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  w.u8(SERVER_TYPES.indexOf(msg.type));
  switch (msg.type) {
    case 'challenge':
      w.str(msg.nonce, LIMITS.auth);
      break;
    case 'welcome':
      w.uint(msg.playerId);
      w.uint(msg.tick);
      writeRoom(w, msg.room);
      break;
    case 'joinRejected':
      w.u8(REJECT_REASONS.indexOf(msg.reason));
      break;
    case 'events':
      w.uint(msg.tick);
      w.uint(msg.events.length);
      for (const ev of msg.events) writeEvent(w, ev);
      break;
    case 'hash':
      w.uint(msg.tick);
      w.uint(msg.hash);
      break;
    case 'snapshot':
      w.uint(msg.tick);
      writeRoom(w, msg.room);
      break;
    case 'ping':
      w.f64(msg.t);
      break;
    case 'disconnected':
      w.str(msg.reason, LIMITS.reason);
      break;
  }
  return w.finish();
}

function readServerMessage(r: Reader): ServerMessage {
  const type = pick(SERVER_TYPES, r.u8(), 'server message');
  switch (type) {
    case 'challenge':
      return { type, nonce: r.str(LIMITS.auth) };
    case 'welcome':
      return { type, playerId: r.uint(), tick: r.uint(), room: readRoom(r) };
    case 'joinRejected':
      return { type, reason: pick(REJECT_REASONS, r.u8(), 'reject reason') };
    case 'events': {
      const tick = r.uint();
      const events: RoomEvent[] = [];
      for (let i = r.count(); i > 0; i--) events.push(readEvent(r));
      return { type, tick, events };
    }
    case 'hash':
      return { type, tick: r.uint(), hash: r.uint() };
    case 'snapshot':
      return { type, tick: r.uint(), room: readRoom(r) };
    case 'ping':
      return { type, t: r.f64() };
    case 'disconnected':
      return { type, reason: r.str(LIMITS.reason) };
  }
}

export function decodeServerMessage(data: Uint8Array | ArrayBuffer): ServerMessage {
  const r = new Reader(data);
  const msg = readServerMessage(r);
  r.end();
  return msg;
}
