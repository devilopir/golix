import { ReplayRecorder } from '@golix/replay';
import { Room, type Schedule } from '@golix/room';
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS, hostOnLobby, type LobbyHost } from '@golix/room/host';
import type { GolixServer, ServerOptions } from '@golix/server';
import {
  ActionFlags,
  CollisionFlags,
  InputFlags,
  LIMITS,
  Team,
  defaultStadiums,
  getStadium,
  parseStadium,
  type CreateRoomRequest,
  type Disc,
  type CameraFollow,
  type DiscProperties,
  type JointEnd,
  type PlayerPhysicsOverrides,
  type RoomEvent,
  type RoomPlayer,
  type TickOutcome,
} from '@golix/shared';

export { JoinError } from '@golix/client';
export { joinRoom, type JoinRoomOptions, type JoinedRoom } from './join.ts';

export type TeamID = Team;

export interface RoomConfigObject {
  roomName?: string;
  playerName?: string;
  password?: string;
  maxPlayers?: number;
  public?: boolean;
  /** Location shown in the room list. */
  geo?: { code: string; lat: number; lon: number };
  /** With `lobby`: a room token from the lobby's /headlesstoken page, needed the first time a room secret registers. */
  token?: string;
  noPlayer?: boolean;
  /** ws:// or wss:// address of a remote lobby to register the room with; joiners then connect to this process over WebRTC or the lobby relay. */
  lobby?: string;
  /** With `lobby`: 22-character registration secret (A-Z, a-z, 0-9, - and _) that keeps the room id across restarts. */
  roomSecret?: string;
  /** Without `lobby`: server that serves the room; a new one is started with these options otherwise (default port 8787). */
  server?: GolixServer | ServerOptions;
  /** Origin of the web client, used for the room link; defaults to the lobby's https:// origin or the local dev client. */
  clientUrl?: string;
  /** Golix only: the timer the room ticks on; browsers pass a worker clock so a hidden tab keeps the game smooth. */
  schedule?: Schedule;
  /** With `lobby`: how joiners' WebRTC connections reach this process. */
  webrtc?: {
    /** Local address to gather ICE candidates on, e.g. to give each room its own IP. */
    bindAddress?: string;
    /** First and last UDP port to use. */
    portRange?: [number, number];
    /** Used instead of the STUN and TURN servers the lobby hands out. */
    iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  };
}

export interface PlayerObject {
  id: number;
  name: string;
  team: TeamID;
  admin: boolean;
  position: { x: number; y: number } | null;
  input: number;
  /** Only set in onPlayerJoin; null elsewhere or when the player sent none. */
  auth: string | null;
  /** Only set in onPlayerJoin. */
  conn: string | null;
  /** Golix only: the lowercase ISO 3166-1 alpha-2 code of the player's flag, empty when none. */
  country: string;
}

export interface ScoresObject {
  red: number;
  blue: number;
  time: number;
  scoreLimit: number;
  /** Seconds. */
  timeLimit: number;
}

export type DiscPropertiesObject = { [K in keyof DiscProperties]: number };

export type AnnouncementStyle = Extract<RoomEvent, { type: 'announcement' }>['style'];

export interface RoomEvents {
  onPlayerJoin(player: PlayerObject): void;
  onPlayerLeave(player: PlayerObject): void;
  onTeamVictory(scores: ScoresObject): void;
  /** Returning false keeps the message from the other players. */
  onPlayerChat(player: PlayerObject, message: string): boolean | void;
  /** Golix adds `discIndexes`: the getDiscProperties indexes of every disc the kick reached, the ball being 0. */
  onPlayerBallKick(player: PlayerObject, discIndexes: number[]): void;
  onTeamGoal(team: TeamID): void;
  onGameStart(byPlayer: PlayerObject | null): void;
  onGameStop(byPlayer: PlayerObject | null): void;
  onPlayerAdminChange(changedPlayer: PlayerObject, byPlayer: PlayerObject | null): void;
  onPlayerTeamChange(changedPlayer: PlayerObject, byPlayer: PlayerObject | null): void;
  onPlayerKicked(kickedPlayer: PlayerObject, reason: string, ban: boolean, byPlayer: PlayerObject | null): void;
  onGameTick(): void;
  onGamePause(byPlayer: PlayerObject | null): void;
  onGameUnpause(byPlayer: PlayerObject | null): void;
  onPositionsReset(): void;
  onPlayerActivity(player: PlayerObject): void;
  onPlayerInput(player: PlayerObject, prevInput: number): void;
  onStadiumChange(newStadiumName: string, byPlayer: PlayerObject | null): void;
  onRoomLink(url: string): void;
  onKickRateLimitSet(min: number, rate: number, burst: number, byPlayer: PlayerObject | null): void;
  /** Golix only: the player pressed kick while the kick rate limit had no kick left, so the kick waits until one comes back. */
  onKickRateLimitReached(player: PlayerObject): void;
  /** Golix only: the joint at that index stretched past its breakLength and is gone; later joints moved down by one. */
  onJointBreak(jointIndex: number): void;
  onTeamsLockChange(locked: boolean, byPlayer: PlayerObject | null): void;
  /** Golix only: an action key (1 to 6) went down or up; only sent in rooms that called setActionKeys(true). */
  onPlayerAction(player: PlayerObject, actionId: number, isPressed: boolean): void;
  /** Golix only, named as in node-haxball: two discs bounced off each other. Disc indexes are getDiscProperties indexes. */
  onCollisionDiscVsDisc(discIndex1: number, discIndex2: number): void;
  /** Golix only: a disc bounced off the stadium's plane at that index. */
  onCollisionDiscVsPlane(discIndex: number, planeIndex: number): void;
  /** Golix only: a disc bounced off the stadium's segment at that index. */
  onCollisionDiscVsSegment(discIndex: number, segmentIndex: number): void;
  /** Golix only: a disc bounced off the stadium's vertex at that index. */
  onCollisionDiscVsVertex(discIndex: number, vertexIndex: number): void;
  /** Golix only: the lobby is out of reach and the next registration attempt is in `retryInMs`; called again for each failed attempt. Players on WebRTC stay, new ones cannot join meanwhile. */
  onLobbyDisconnect(retryInMs: number): void;
  /** Golix only: registered with the lobby again under the same room link. */
  onLobbyReconnect(): void;
}

const DISC_KEYS = ['x', 'y', 'xspeed', 'yspeed', 'xgravity', 'ygravity', 'radius', 'bCoeff', 'invMass', 'damping', 'color', 'cMask', 'cGroup'] as const;
const FLOAT_KEYS: ReadonlySet<string> = new Set(['x', 'y', 'xspeed', 'yspeed', 'xgravity', 'ygravity', 'radius', 'bCoeff', 'invMass', 'damping']);
/** Original default stadium names, in the order of our built-ins they stand for. */
const ORIGINAL_STADIUM_NAMES = ['Classic', 'Easy', 'Small', 'Big', 'Rounded', 'Hockey', 'Big Hockey', 'Big Easy', 'Big Rounded', 'Huge'];
const HOST_ID = 0;
const MAX_PLAYERS = 30;
const DEFAULT_MAX_PLAYERS = 12;
const DEFAULT_PORT = 8787;

function clip(text: string, max: number): string {
  return [...text].slice(0, max).join('');
}

function discProperties(d: Disc): DiscPropertiesObject {
  return {
    x: d.pos.x,
    y: d.pos.y,
    xspeed: d.speed.x,
    yspeed: d.speed.y,
    xgravity: d.gravity.x,
    ygravity: d.gravity.y,
    radius: d.radius,
    bCoeff: d.bCoef,
    invMass: d.invMass,
    damping: d.damping,
    color: d.color,
    cMask: d.cMask,
    cGroup: d.cGroup,
  };
}

/** The original stores disc floats as float32, so set values come back rounded. */
function toDiscProperties(props: Partial<Record<keyof DiscProperties, number | null>>): DiscProperties {
  return Object.fromEntries(
    DISC_KEYS.map((k) => {
      const v = props[k] ?? null;
      return [k, v !== null && FLOAT_KEYS.has(k) ? Math.fround(v) : v];
    }),
  ) as unknown as DiscProperties;
}

export class RoomObject implements Partial<RoomEvents> {
  readonly CollisionFlags: typeof CollisionFlags = CollisionFlags;
  readonly InputFlags: typeof InputFlags = InputFlags;

  onPlayerJoin?: RoomEvents['onPlayerJoin'];
  onPlayerLeave?: RoomEvents['onPlayerLeave'];
  onTeamVictory?: RoomEvents['onTeamVictory'];
  onPlayerChat?: RoomEvents['onPlayerChat'];
  onPlayerBallKick?: RoomEvents['onPlayerBallKick'];
  onTeamGoal?: RoomEvents['onTeamGoal'];
  onGameStart?: RoomEvents['onGameStart'];
  onGameStop?: RoomEvents['onGameStop'];
  onPlayerAdminChange?: RoomEvents['onPlayerAdminChange'];
  onPlayerTeamChange?: RoomEvents['onPlayerTeamChange'];
  onPlayerKicked?: RoomEvents['onPlayerKicked'];
  onGameTick?: RoomEvents['onGameTick'];
  onGamePause?: RoomEvents['onGamePause'];
  onGameUnpause?: RoomEvents['onGameUnpause'];
  onPositionsReset?: RoomEvents['onPositionsReset'];
  onPlayerActivity?: RoomEvents['onPlayerActivity'];
  onPlayerInput?: RoomEvents['onPlayerInput'];
  onStadiumChange?: RoomEvents['onStadiumChange'];
  onRoomLink?: RoomEvents['onRoomLink'];
  onKickRateLimitSet?: RoomEvents['onKickRateLimitSet'];
  onKickRateLimitReached?: RoomEvents['onKickRateLimitReached'];
  onJointBreak?: RoomEvents['onJointBreak'];
  onTeamsLockChange?: RoomEvents['onTeamsLockChange'];
  onPlayerAction?: RoomEvents['onPlayerAction'];
  onCollisionDiscVsDisc?: RoomEvents['onCollisionDiscVsDisc'];
  onCollisionDiscVsPlane?: RoomEvents['onCollisionDiscVsPlane'];
  onCollisionDiscVsSegment?: RoomEvents['onCollisionDiscVsSegment'];
  onCollisionDiscVsVertex?: RoomEvents['onCollisionDiscVsVertex'];
  onLobbyDisconnect?: RoomEvents['onLobbyDisconnect'];
  onLobbyReconnect?: RoomEvents['onLobbyReconnect'];

  readonly #room: Room;
  readonly #hostPlayer: boolean;
  /** Every player seen, kept until their leave callbacks ran. */
  readonly #players = new Map<number, RoomPlayer>();
  readonly #inputs = new Map<number, number>();
  #recorder: ReplayRecorder | null = null;
  #recordFromNextTick = false;
  #tickEvents: RoomEvent[] = [];
  #lobby: LobbyHost | null = null;

  constructor(config: RoomConfigObject) {
    this.#hostPlayer = config.noPlayer !== true;
    this.#room = new Room({
      name: clip(config.roomName ?? 'Headless Room', LIMITS.roomName),
      maxPlayers: Math.min(MAX_PLAYERS, Math.max(2, config.maxPlayers ?? DEFAULT_MAX_PLAYERS)),
      password: clip(config.password ?? '', LIMITS.password),
      autoAdmin: false,
      hooks: {
        onEvent: (ev) => this.#onEvent(ev),
        allowChat: (playerId, text) => {
          const player = this.#players.get(playerId);
          return player === undefined || this.#call('onPlayerChat', this.#object(player), text) !== false;
        },
        onStep: (outcomes, simulated) => this.#onStep(outcomes, simulated),
        onCollision: (c) => {
          if (c.kind === 'disc') this.#call('onCollisionDiscVsDisc', c.disc, c.other);
          else if (c.kind === 'plane') this.#call('onCollisionDiscVsPlane', c.disc, c.index);
          else if (c.kind === 'segment') this.#call('onCollisionDiscVsSegment', c.disc, c.index);
          else this.#call('onCollisionDiscVsVertex', c.disc, c.index);
        },
      },
    });
    if (this.#hostPlayer) {
      const player: RoomPlayer = { id: HOST_ID, name: clip(config.playerName ?? 'Host', LIMITS.name), team: Team.spectators, admin: true, avatar: '', country: (config.geo?.code ?? '').toLowerCase(), joinSeq: 0, ping: 0 };
      this.#room.hostEvent({ type: 'playerJoin', player });
    }
    this.#room.start(config.schedule);

    const { code = '', lat = 0, lon = 0 } = config.geo ?? {};
    const request: CreateRoomRequest = { name: this.#room.state.name, maxPlayers: this.#room.state.maxPlayers, public: config.public ?? true, country: code.toLowerCase(), lat, lon };
    const link = (id: string) => {
      const url = new URL('/play', config.clientUrl ?? config.lobby?.replace(/^ws/, 'http') ?? 'http://localhost:5173');
      url.searchParams.set('c', id);
      if (this.#room.state.hasPassword) url.searchParams.set('p', '1');
      return url.href;
    };
    if (config.lobby !== undefined) {
      void this.#serveLobby(config.lobby, request, link, config.roomSecret, config.token, config.webrtc ?? {});
      return;
    }
    const server = config.server ?? { port: DEFAULT_PORT };
    if ('addRoom' in server) {
      const href = link(server.addRoom(this.#room, request));
      this.#setCaptchaAvailable(server.captcha);
      queueMicrotask(() => this.#call('onRoomLink', href));
    } else {
      // Loaded on demand so HBInit with a lobby also runs in a browser.
      void import('@golix/server')
        .then(({ createServer }) => createServer(server))
        .then((s) => {
          this.#setCaptchaAvailable(s.captcha);
          this.#call('onRoomLink', link(s.addRoom(this.#room, request)));
        });
    }
  }

  /** Retries the first registration with backoff; afterwards the lobby host re-registers by itself under the same id. */
  async #serveLobby(serverUrl: string, request: CreateRoomRequest, link: (id: string) => string, secret: string | undefined, token: string | undefined, webrtc: NonNullable<RoomConfigObject['webrtc']>): Promise<void> {
    const { RTCPeerConnection } = 'RTCPeerConnection' in globalThis ? globalThis : await import('node-datachannel/polyfill');
    // The polyfill passes extra fields through to libdatachannel's own configuration; browsers ignore them.
    const local = { bindAddress: webrtc.bindAddress, portRangeBegin: webrtc.portRange?.[0], portRangeEnd: webrtc.portRange?.[1] };
    for (let delay = RECONNECT_MIN_MS; ; delay = Math.min(delay * 2, RECONNECT_MAX_MS)) {
      try {
        this.#lobby = await hostOnLobby(this.#room, {
          serverUrl,
          request,
          secret,
          token,
          // The polyfill implements RTCPeerConnection but its event classes have private fields the DOM types lack.
          createPeerConnection: (c) => new RTCPeerConnection({ ...c, ...local, iceServers: webrtc.iceServers ?? c.iceServers }) as unknown as globalThis.RTCPeerConnection,
          onLost: (retryInMs) => {
            console.warn(`Lost the lobby at ${serverUrl}, reconnecting in ${retryInMs / 1000} s`);
            this.#call('onLobbyDisconnect', retryInMs);
          },
          onBack: () => this.#call('onLobbyReconnect'),
        });
        this.#setCaptchaAvailable(this.#lobby.captcha);
        this.#call('onRoomLink', link(this.#lobby.id));
        return;
      } catch (e) {
        console.warn(`Could not register with the lobby at ${serverUrl} (${(e as Error).message}), retrying in ${delay / 1000} s`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  sendChat(message: string, targetId: number | null = null): void {
    if (!this.#hostPlayer) return;
    this.#room.hostEvent({ type: 'chat', playerId: HOST_ID, text: clip(message, LIMITS.chat) }, targetId);
  }

  sendAnnouncement(msg: string, targetId: number | null = null, color: number | null = null, style: AnnouncementStyle | null = null, sound: 0 | 1 | 2 | null = null): void {
    const text = clip(msg, LIMITS.announcement);
    this.#room.hostEvent({ type: 'announcement', text, targetId, color: color ?? -1, style: style ?? 'normal', sound: sound ?? 1 }, targetId);
  }

  setPlayerAdmin(playerID: number, admin: boolean): void {
    this.#room.hostEvent({ type: 'setAdmin', playerId: playerID, admin, byPlayer: null });
  }

  setPlayerTeam(playerID: number, team: TeamID): void {
    this.#room.hostEvent({ type: 'setTeam', playerId: playerID, team, byPlayer: null, announce: false });
  }

  kickPlayer(playerID: number, reason: string | null, ban: boolean): void {
    this.#room.hostEvent({ type: 'playerLeave', playerId: playerID, kicked: true, ban, reason: clip(reason ?? '', LIMITS.reason), byPlayer: null });
  }

  clearBan(playerId: number): void {
    this.#room.clearBan(playerId);
  }

  clearBans(): void {
    this.#room.clearBans();
  }

  setScoreLimit(limit: number): void {
    this.#room.hostEvent({ type: 'setScoreLimit', value: limit, byPlayer: null });
  }

  setTimeLimit(limitInMinutes: number): void {
    this.#room.hostEvent({ type: 'setTimeLimit', value: limitInMinutes, byPlayer: null });
  }

  /** Throws a StadiumError when the text is not a valid stadium. */
  setCustomStadium(stadiumFileContents: string): void {
    parseStadium(stadiumFileContents);
    this.#room.hostEvent({ type: 'setStadium', source: stadiumFileContents, byPlayer: null });
  }

  /** Also takes the original default stadium names. */
  setDefaultStadium(stadiumName: string): void {
    const alias = ORIGINAL_STADIUM_NAMES.indexOf(stadiumName);
    const stadium = alias === -1 ? defaultStadiums.find((s) => s.name === stadiumName) : defaultStadiums[alias];
    if (stadium !== undefined) this.#room.hostEvent({ type: 'setStadium', source: stadium.source, byPlayer: null });
  }

  setTeamsLock(locked: boolean): void {
    this.#room.hostEvent({ type: 'setTeamsLock', locked, byPlayer: null });
  }

  setTeamColors(team: TeamID, angle: number, textColor: number, colors: number[]): void {
    if (team === Team.spectators) return;
    this.#room.hostEvent({ type: 'setTeamColors', team, colors: { angle, textColor, colors: colors.slice(0, LIMITS.teamColors) }, byPlayer: null });
  }

  /** Golix only: dresses one player in their own kit instead of the team's; up to LIMITS.teamColors stripes. */
  setPlayerColors(playerId: number, angle: number, textColor: number, colors: number[]): void {
    this.#room.hostEvent({ type: 'setPlayerColors', playerId, colors: { angle, textColor, colors: colors.slice(0, LIMITS.teamColors) } });
  }

  /**
   * Golix only: changes the stadium's player physics for one player, e.g. `{ kickStrength: 7, acceleration: 0.12 }`; fields left
   * out keep the stadium's value and null clears all of them. Unlike setPlayerDiscProperties it lasts across kickoffs.
   */
  setPlayerPhysics(playerId: number, physics: PlayerPhysicsOverrides | null): void {
    this.#room.hostEvent({ type: 'setPlayerPhysics', playerId, physics });
  }

  /**
   * Golix only: pins text on every player's game screen, or replaces the item with the same id. `x` and `y` place it as a
   * fraction of the screen from the top left; up to 16 items of 100 characters.
   */
  setHudItem(id: string, item: { text: string; x: number; y: number; align?: 'left' | 'center' | 'right'; color?: number; size?: number }): void {
    const { text, x, y, align = 'center', color = 0xffffff, size = 16 } = item;
    this.#room.hostEvent({ type: 'setHudItem', id: clip(id, LIMITS.hudId), item: { text: clip(text, LIMITS.hudText), x, y, align, color, size } });
  }

  /** Golix only: takes a setHudItem item off the screen. */
  clearHudItem(id: string): void {
    this.#room.hostEvent({ type: 'setHudItem', id: clip(id, LIMITS.hudId), item: null });
  }

  /**
   * Golix only: points every player's camera at a player, a disc (getDiscProperties index) or a point, and multiplies their
   * zoom by `zoom` (0.25 to 4). Null follows the ball and the player again.
   */
  setCamera(follow: { playerId: number } | { discIndex: number } | { x: number; y: number } | null, zoom = 1): void {
    const target: CameraFollow | null =
      follow === null ? null : 'playerId' in follow ? { type: 'player', id: follow.playerId } : 'discIndex' in follow ? { type: 'disc', index: follow.discIndex } : { type: 'point', x: follow.x, y: follow.y };
    this.#room.hostEvent({ type: 'setCamera', camera: { follow: target, zoom } });
  }

  /** Golix only: the player's changes from setPlayerPhysics, or null. */
  getPlayerPhysics(playerId: number): PlayerPhysicsOverrides | null {
    const physics = this.#room.state.players.find((p) => p.id === playerId)?.physics;
    return physics === undefined ? null : { ...physics };
  }

  /** Golix only: puts the player back in the team's kit. */
  clearPlayerColors(playerId: number): void {
    this.#room.hostEvent({ type: 'setPlayerColors', playerId, colors: null });
  }

  /** Golix only: lets players send the action keys 1 to 6, reported to onPlayerAction; they do nothing by themselves. */
  setActionKeys(enabled: boolean): void {
    this.#room.hostEvent({ type: 'setActionKeys', enabled });
  }

  /** Golix only: renames the room, here and in the room list. */
  setRoomName(name: string): void {
    this.#room.hostEvent({ type: 'setRoomProps', name: clip(name, LIMITS.roomName), maxPlayers: null });
  }

  /** Golix only: 2 to 30; players already in stay when it drops below their number. */
  setMaxPlayers(max: number): void {
    this.#room.hostEvent({ type: 'setRoomProps', name: null, maxPlayers: max });
  }

  /** Golix only: the name shown for a team; an empty one goes back to "Red" or "Blue". */
  setTeamName(team: TeamID, name: string): void {
    if (team === Team.red || team === Team.blue) this.#room.hostEvent({ type: 'setTeamName', team, name: clip(name, LIMITS.teamName) });
  }

  /**
   * Golix only: changes the running game. `time` is the clock in seconds, `timeLimit` in minutes as in setTimeLimit,
   * so adding a minute is `setGameProperties({ timeLimit: getScores().timeLimit / 60 + 1 })`. Fields left out stay.
   */
  setGameProperties(props: { red?: number; blue?: number; time?: number; scoreLimit?: number; timeLimit?: number }): void {
    const { red = null, blue = null, time = null, scoreLimit = null, timeLimit = null } = props;
    this.#room.hostEvent({ type: 'setGameProps', red, blue, time, scoreLimit, timeLimit });
  }

  /**
   * Golix only: ties two discs of the running game together until the game ends. An end is a stadium disc
   * (`{ discIndex }`, below the stadium's disc count) or a player (`{ playerId }`), whose joint rests while they are
   * off the field. `length` defaults to the distance when it applies, `strength` to rigid; past `breakLength` it breaks.
   * Joints go at the end of the list in call order.
   */
  addJoint(joint: {
    d0: { discIndex: number } | { playerId: number };
    d1: { discIndex: number } | { playerId: number };
    length?: number | [min: number, max: number] | null;
    strength?: number | 'rigid';
    color?: number | 'transparent';
    breakLength?: number | null;
  }): void {
    const end = (e: { discIndex: number } | { playerId: number }): JointEnd => ('playerId' in e ? { player: e.playerId } : { disc: e.discIndex });
    const { length = null, strength = 'rigid', color = 'transparent', breakLength = null } = joint;
    this.#room.hostEvent({
      type: 'addJoint',
      joint: {
        a: end(joint.d0),
        b: end(joint.d1),
        length: typeof length === 'number' ? [length, length] : length,
        strength: strength === 'rigid' ? Infinity : strength,
        color: color === 'transparent' ? -1 : color,
        breakLength: breakLength ?? Infinity,
      },
    });
  }

  /** Golix only: removes the joint at that index of the running game, stadium joints included; later ones move down. */
  removeJoint(jointIndex: number): void {
    this.#room.hostEvent({ type: 'removeJoint', index: jointIndex });
  }

  /** Golix only: the running game's joints, the stadium's first; 0 without a game. */
  getJointCount(): number {
    return this.#room.state.game?.joints.length ?? 0;
  }

  startGame(): void {
    this.#room.hostEvent({ type: 'startGame', byPlayer: null });
  }

  stopGame(): void {
    this.#room.hostEvent({ type: 'stopGame', byPlayer: null });
  }

  pauseGame(pauseState: boolean): void {
    this.#room.hostEvent({ type: 'setPaused', paused: pauseState, byPlayer: null });
  }

  getPlayer(playerId: number): PlayerObject | null {
    const player = this.#room.state.players.find((p) => p.id === playerId);
    return player === undefined ? null : this.#object(player);
  }

  getPlayerList(): PlayerObject[] {
    return this.#room.state.players.map((p) => this.#object(p));
  }

  getScores(): ScoresObject | null {
    const game = this.#room.state.game;
    if (game === null) return null;
    return { red: game.red, blue: game.blue, time: game.time, scoreLimit: game.scoreLimit, timeLimit: game.timeLimit * 60 };
  }

  getBallPosition(): { x: number; y: number } | null {
    const ball = this.#room.state.game?.discs[0];
    return ball === undefined ? null : { x: ball.pos.x, y: ball.pos.y };
  }

  /** Records from the end of the current tick, so a call from inside a callback never splits a tick. */
  startRecording(): void {
    if (this.#recorder === null) this.#recordFromNextTick = true;
  }

  /** Returns a .glx replay. */
  stopRecording(): Uint8Array | null {
    const recorder = this.#recorder;
    this.#recorder = null;
    this.#recordFromNextTick = false;
    return recorder === null ? null : recorder.finish();
  }

  setPassword(pass: string | null): void {
    this.#room.setPassword(pass === null || pass === '' ? null : clip(pass, LIMITS.password));
  }

  /** Joiners must solve a Turnstile captcha where the lobby verifies them; elsewhere the join limit drops to one attempt per address every 30 seconds. */
  setRequireRecaptcha(required: boolean): void {
    this.#room.setRequireCaptcha(required);
    this.#lobby?.update();
  }

  /** Golix only: guards the room for `minutes` once `joins` players join within `seconds`, as setRequireRecaptcha does; null turns it off. On by default with 6 joins in 10 s for 5 minutes. */
  setRaidProtection(protection: { joins: number; seconds: number; minutes: number } | null): void {
    this.#room.setRaidProtection(protection);
  }

  /** Golix only: how many players one network address may have in the room; null removes the limit. */
  setMaxPlayersPerConn(limit: number | null): void {
    this.#room.setMaxPlayersPerConn(limit ?? Infinity);
  }

  #setCaptchaAvailable(available: boolean): void {
    this.#room.setCaptchaAvailable(available);
    this.#lobby?.update();
  }

  reorderPlayers(playerIdList: number[], moveToTop: boolean): void {
    this.#room.hostEvent({ type: 'reorderPlayers', playerIds: playerIdList, moveToTop });
  }

  setKickRateLimit(min = 2, rate = 0, burst = 0): void {
    this.#room.hostEvent({ type: 'setKickRateLimit', limit: { min, rate, burst }, byPlayer: null });
  }

  setPlayerAvatar(playerId: number, avatar: string | null): void {
    this.#room.overrideAvatar(playerId, avatar === null ? null : clip(avatar, LIMITS.avatar));
  }

  setDiscProperties(discIndex: number, properties: Partial<DiscPropertiesObject>): void {
    const game = this.#room.state.game;
    if (game === null || discIndex < 0) return;
    const props = toDiscProperties(properties);
    if (discIndex < game.discs.length) {
      this.#room.hostEvent({ type: 'setDiscProperties', discIndex, props });
      return;
    }
    const owner = game.players.filter((p) => p.disc !== null)[discIndex - game.discs.length];
    if (owner !== undefined) this.#room.hostEvent({ type: 'setPlayerDiscProperties', playerId: owner.id, props });
  }

  getDiscProperties(discIndex: number): DiscPropertiesObject | null {
    const disc = this.#discs()[discIndex];
    return disc === undefined ? null : discProperties(disc);
  }

  setPlayerDiscProperties(playerId: number, properties: Partial<DiscPropertiesObject>): void {
    this.#room.hostEvent({ type: 'setPlayerDiscProperties', playerId, props: toDiscProperties(properties) });
  }

  getPlayerDiscProperties(playerId: number): DiscPropertiesObject | null {
    const disc = this.#room.state.game?.players.find((p) => p.id === playerId)?.disc;
    return disc == null ? null : discProperties(disc);
  }

  getDiscCount(): number {
    return this.#discs().length;
  }

  /** Stadium discs then player discs, the order the simulation steps them in. */
  #discs(): Disc[] {
    const game = this.#room.state.game;
    if (game === null) return [];
    return [...game.discs, ...game.players.flatMap((p) => (p.disc === null ? [] : [p.disc]))];
  }

  #object(player: RoomPlayer): PlayerObject {
    const sim = this.#room.state.game?.players.find((p) => p.id === player.id);
    const disc = sim?.disc ?? null;
    return {
      id: player.id,
      name: player.name,
      team: player.team,
      admin: player.admin,
      position: disc === null ? null : { x: disc.pos.x, y: disc.pos.y },
      input: sim?.input ?? 0,
      auth: null,
      conn: null,
      country: player.country,
    };
  }

  #by(playerId: number | null): PlayerObject | null {
    const player = playerId === null ? undefined : this.#players.get(playerId);
    return player === undefined ? null : this.#object(player);
  }

  #call<K extends keyof RoomEvents>(name: K, ...args: Parameters<RoomEvents[K]>): ReturnType<RoomEvents[K]> | undefined {
    const handler = this[name] as ((...a: Parameters<RoomEvents[K]>) => ReturnType<RoomEvents[K]>) | undefined;
    if (handler === undefined) return undefined;
    try {
      return handler.apply(this, args);
    } catch (e) {
      console.error(`${name} threw`, e);
      return undefined;
    }
  }

  #onEvent(ev: RoomEvent): void {
    this.#lobby?.update();
    if (this.#recorder !== null) this.#tickEvents.push(ev);
    switch (ev.type) {
      case 'playerJoin': {
        const player = this.#room.state.players.find((p) => p.id === ev.player.id);
        if (player === undefined) return;
        this.#players.set(player.id, player);
        const info = this.#room.peerInfo(player.id);
        if (info === undefined) return;
        this.#call('onPlayerJoin', { ...this.#object(player), auth: info.auth === '' ? null : info.auth, conn: info.conn });
        return;
      }
      case 'playerLeave': {
        const player = this.#players.get(ev.playerId);
        if (player === undefined) return;
        const object = this.#object(player);
        this.#call('onPlayerLeave', object);
        if (ev.kicked) this.#call('onPlayerKicked', object, ev.reason, ev.ban, this.#by(ev.byPlayer));
        this.#players.delete(ev.playerId);
        this.#inputs.delete(ev.playerId);
        return;
      }
      case 'input': {
        const player = this.#players.get(ev.playerId);
        if (player === undefined) return;
        const prev = this.#inputs.get(ev.playerId) ?? 0;
        this.#inputs.set(ev.playerId, ev.input);
        const object = this.#object(player);
        this.#call('onPlayerActivity', object);
        if (ev.input !== prev) this.#call('onPlayerInput', { ...object, input: ev.input }, prev);
        const sim = this.#room.state.game?.players.find((p) => p.id === ev.playerId);
        // The next step counts both down by one before it checks them, as stepRoom does.
        const held = sim !== undefined && (sim.kickCooldown > 1 || sim.kickTokens < -1);
        if ((ev.input & ~prev & InputFlags.kick) !== 0 && held) this.#call('onKickRateLimitReached', object);
        ActionFlags.forEach((flag, i) => {
          if (((ev.input ^ prev) & flag) !== 0) this.#call('onPlayerAction', { ...object, input: ev.input }, i + 1, (ev.input & flag) !== 0);
        });
        return;
      }
      case 'setTeam': {
        const player = this.#players.get(ev.playerId);
        if (player !== undefined) this.#call('onPlayerTeamChange', this.#object(player), this.#by(ev.byPlayer));
        return;
      }
      case 'setAdmin': {
        const player = this.#players.get(ev.playerId);
        if (player !== undefined) this.#call('onPlayerAdminChange', this.#object(player), this.#by(ev.byPlayer));
        return;
      }
      case 'startGame':
        this.#call('onGameStart', this.#by(ev.byPlayer));
        return;
      case 'stopGame':
        this.#call('onGameStop', this.#by(ev.byPlayer));
        return;
      case 'setPaused':
        if (ev.paused) this.#call('onGamePause', this.#by(ev.byPlayer));
        else this.#call('onGameUnpause', this.#by(ev.byPlayer));
        return;
      case 'setStadium':
        this.#call('onStadiumChange', getStadium(ev.source).name, this.#by(ev.byPlayer));
        return;
      case 'setKickRateLimit':
        this.#call('onKickRateLimitSet', ev.limit.min, ev.limit.rate, ev.limit.burst, this.#by(ev.byPlayer));
        return;
      case 'setTeamsLock':
        this.#call('onTeamsLockChange', ev.locked, this.#by(ev.byPlayer));
        return;
      default:
        return;
    }
  }

  #onStep(outcomes: TickOutcome[], simulated: boolean): void {
    for (const o of outcomes) {
      switch (o.type) {
        case 'kick': {
          const player = this.#players.get(o.playerId);
          if (player !== undefined) this.#call('onPlayerBallKick', this.#object(player), [...o.discs]);
          break;
        }
        case 'jointBreak':
          this.#call('onJointBreak', o.index);
          break;
        case 'goal':
          this.#call('onTeamGoal', o.team);
          break;
        case 'victory': {
          const scores = this.getScores();
          if (scores !== null) this.#call('onTeamVictory', scores);
          break;
        }
        case 'positionsReset':
          this.#call('onPositionsReset');
          break;
        case 'gameStop':
          this.#call('onGameStop', null);
          break;
        case 'kickoff':
          break;
      }
    }
    if (simulated && this.#room.state.game !== null) this.#call('onGameTick');
    this.#record();
  }

  #record(): void {
    if (this.#recordFromNextTick) {
      this.#recordFromNextTick = false;
      this.#recorder = new ReplayRecorder(this.#room.state);
    } else {
      this.#recorder?.tick(this.#tickEvents, this.#room.state);
    }
    this.#tickEvents = [];
  }
}

export function HBInit(roomConfig: RoomConfigObject = {}): RoomObject {
  return new RoomObject(roomConfig);
}

declare global {
  /** Called once HBInit is ready, like in the original headless page. */
  var onHBLoaded: (() => void) | undefined;
}

queueMicrotask(() => globalThis.onHBLoaded?.());

export { CollisionFlags, InputFlags };
