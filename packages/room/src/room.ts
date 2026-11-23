import {
  HASH_INTERVAL,
  LIMITS,
  PROTOCOL_VERSION,
  Reader,
  TICKS_PER_SECOND,
  Team,
  Writer,
  applyEvent,
  createRoomState,
  decodeClientMessage,
  encodeServerMessage,
  hashRoom,
  inputMask,
  joinVersion,
  parseStadium,
  readEvent,
  stepRoom,
  writeEvent,
  type ClientMessage,
  type Collision,
  type JointEnd,
  type RoomEvent,
  type RoomPlayer,
  type RoomState,
  type TeamColors,
  type ServerMessage,
  type TickOutcome,
  type Transport,
  verifiedMessage,
} from '@golix/shared';
import { verifyP256 } from './p256.ts';

export interface ChatRateLimit {
  burst: number;
  /** Ticks to regain one message. */
  intervalTicks: number;
}

export interface RoomOptions {
  name: string;
  maxPlayers: number;
  /** A peer silent for this long is dropped. */
  timeoutMs?: number;
  chatRateLimit?: ChatRateLimit;
  /** Called once the room has neither players nor connections; without it the room lives until closed. */
  onEmpty?: () => void;
  /** Fixes the password at creation; otherwise the first joiner sets it. */
  password?: string;
  /** When false, nobody gets admin by joining first or by hand-over. Defaults to true. */
  autoAdmin?: boolean;
  hooks?: RoomHooks;
}

/** Synchronous callbacks from inside a tick; room methods called from them take effect on the next tick. */
export interface RoomHooks {
  /** After the event is applied. */
  onEvent?(ev: RoomEvent): void;
  /** Return false to drop a player's chat message. */
  allowChat?(playerId: number, text: string): boolean;
  /** After the game step; `simulated` is false when no game ran or it was paused. */
  onStep?(outcomes: TickOutcome[], simulated: boolean): void;
  /** Each bounce in the game step, before onStep; only rooms that set it pay for it. */
  onCollision?(collision: Collision): void;
}

/** Calls `run` once after `delayMs`; the returned function cancels it. */
export type Schedule = (run: () => void, delayMs: number) => () => void;

const timeoutSchedule: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/** Feeds a connection's traffic into the room. */
export interface PeerHandle {
  receive(data: Uint8Array | ArrayBuffer): void;
  closed(): void;
}

type JoinMessage = Extract<ClientMessage, { type: 'join' }>;

interface Peer {
  transport: Transport;
  /** Set once the welcome went out; until then only join is accepted. */
  playerId: number | null;
  join: JoinMessage | null;
  nonce: string;
  /** Empty unless the join signed the challenge with the key `auth` names. */
  auth: string;
  conn: string;
  /** The lobby verified a captcha token with this connection, or the join carried the lobby's proof for its auth. */
  captcha: boolean;
  lastSeen: number;
  rttMs: number;
  lastInputTick: number;
  chatTokens: number;
  chatRefillTick: number;
  chatQueue: string[];
  messages: number;
  lastResyncTick: number;
}

type Action =
  | { type: 'join'; peer: Peer }
  | { type: 'leave'; playerId: number }
  | { type: 'chat'; playerId: number; text: string }
  | { type: 'resync'; peer: Peer }
  /** playerId null = host. */
  | { type: 'setPassword'; playerId: number | null; password: string | null }
  | { type: 'clearBans'; playerId: number | null }
  | { type: 'clearBan'; playerId: number }
  | { type: 'overrideAvatar'; playerId: number; avatar: string | null }
  | { type: 'request'; playerId: number; event: RoomEvent }
  | { type: 'host'; event: RoomEvent; targetId: number | null };

const TICK_MS = 1000 / TICKS_PER_SECOND;
const MAX_INPUT_LEAD = TICKS_PER_SECOND;
const PING_INTERVAL = TICKS_PER_SECOND;
const PING_EVENT_INTERVAL = 2 * TICKS_PER_SECOND;
const MAX_MESSAGES_PER_SECOND = 300;
const MAX_LIMIT = 14;
const MAX_HOST_LIMIT = 99;
const MAX_SCORE = 999;
const MAX_JOINTS = 4096;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 30;
const MAX_CHAT_QUEUE = 10;
const PAUSED = 120;
/** Join attempts one connection gets per window; the strict limit stands in for the original's join captcha. */
const JOIN_LIMIT = { attempts: 5, windowTicks: 60 * TICKS_PER_SECOND };
const STRICT_JOIN_LIMIT = { attempts: 1, windowTicks: 30 * TICKS_PER_SECOND };
/** How long a connection that flooded the room stays out. */
const FLOOD_BAN_TICKS = 60 * TICKS_PER_SECOND;

/** A burst of joins from other connections that turns on the room's guard for a while. */
export interface RaidProtection {
  joins: number;
  seconds: number;
  minutes: number;
}

const DEFAULT_RAID: RaidProtection = { joins: 6, seconds: 10, minutes: 5 };
/** Players rejoining a restarted room come in a burst too, so the first minutes are not watched. */
const RAID_GRACE_TICKS = 2 * 60 * TICKS_PER_SECOND;
const MAX_SEEN_AUTHS = 1000;

function inRange(v: number, min: number, max: number): boolean {
  return Number.isInteger(v) && v >= min && v <= max;
}

function isColor(v: number): boolean {
  return inRange(v, 0, 0xffffff);
}

function validColors({ angle, textColor, colors }: TeamColors): boolean {
  return angle >= 0 && angle <= 360 && isColor(textColor) && colors.length <= LIMITS.teamColors && colors.every(isColor);
}

export function toBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on characters outside the base64url alphabet. */
export function fromBase64url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

/** Whether clients can read the event back as the room sends it; host scripts can pass values they cannot. */
function readable(ev: RoomEvent): boolean {
  try {
    const w = new Writer();
    writeEvent(w, ev);
    const r = new Reader(w.finish());
    readEvent(r);
    r.end();
    return true;
  } catch {
    return false;
  }
}

/** `auth` is the base64url uncompressed P-256 point the client's identity exports. */
function verifiedAuth(auth: string, signature: string, nonce: string): string {
  try {
    const point = fromBase64url(auth);
    if (toBase64url(point) !== auth) return '';
    return verifyP256(point, new TextEncoder().encode(nonce), fromBase64url(signature)) ? auth : '';
  } catch {
    return '';
  }
}

export class Room {
  readonly state: RoomState;
  tick = 0;
  private readonly timeoutMs: number;
  private readonly chatRateLimit: ChatRateLimit;
  private readonly onEmpty: (() => void) | undefined;
  private readonly autoAdmin: boolean;
  private readonly hooks: RoomHooks;
  private readonly peers = new Set<Peer>();
  private readonly actions: Action[] = [];
  private readonly inputs = new Map<number, { playerId: number; input: number }[]>();
  /** By banned player id; a ban matches either the auth or, as in the original, the connection. */
  private readonly bans = new Map<number, { auth: string; conn: string }>();
  /** Players whose avatar the host overrides → the avatar they chose themselves. */
  private readonly ownAvatars = new Map<number, string>();
  /** Ticks of recent join attempts by connection. */
  private readonly joinAttempts = new Map<string, number[]>();
  /** Connection → tick its flood ban ends. */
  private readonly floodBans = new Map<string, number>();
  private maxPlayersPerConn = Infinity;
  private requireCaptcha = false;
  private captchaAvailable = false;
  /** Auths the lobby's operators banned from every room. */
  private globalBans: ReadonlySet<string> = new Set();
  /** The lobby's key for verified identities; null when the room is not served by one. */
  private verifyKey: Uint8Array | null = null;
  private raid: RaidProtection | null = DEFAULT_RAID;
  /** Ticks of recent joins from other connections, and the tick the raid guard ends. */
  private recentJoins: number[] = [];
  private raidUntil = -Infinity;
  /** Keys that joined before; they do not count toward a burst, since raiders bring new ones. */
  private readonly seenAuths = new Set<string>();
  /** Players whose snapshot went out last tick; their syncChange true goes out this tick. */
  private readonly resynced: number[] = [];
  private password: string;
  private created: boolean;
  private nextPlayerId = 1;
  private nextJoinSeq = 0;
  private cancelTimer: (() => void) | null = null;
  private emptied = false;
  /** A room nobody has connected to yet is not empty; the server expires those separately. */
  private hadPeer = false;

  constructor(options: RoomOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.chatRateLimit = options.chatRateLimit ?? { burst: 5, intervalTicks: 2 * TICKS_PER_SECOND };
    this.onEmpty = options.onEmpty;
    this.autoAdmin = options.autoAdmin ?? true;
    this.hooks = options.hooks ?? {};
    this.password = options.password ?? '';
    this.created = options.password !== undefined;
    this.state = createRoomState({ name: options.name, maxPlayers: options.maxPlayers, hasPassword: this.password !== '' });
  }

  /** Runs ticks at 60 Hz against a monotonic clock; late timers catch up instead of drifting. */
  start(schedule: Schedule = timeoutSchedule): void {
    if (this.cancelTimer !== null) return;
    const origin = performance.now();
    let done = 0;
    const loop = () => {
      const now = performance.now();
      while (origin + (done + 1) * TICK_MS <= now) {
        done++;
        this.runTick();
      }
      if (this.emptied) return;
      this.cancelTimer = schedule(loop, Math.max(0, origin + (done + 1) * TICK_MS - performance.now()));
    };
    this.cancelTimer = schedule(loop, TICK_MS);
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /**
   * Queues a host-side event (byPlayer null) for the next tick; it is dropped when the game state makes it meaningless.
   * A non-null targetId delivers it to that player only, so use it only for events that leave the state untouched.
   */
  hostEvent(event: RoomEvent, targetId: number | null = null): void {
    this.actions.push({ type: 'host', event, targetId });
  }

  setPassword(password: string | null): void {
    this.actions.push({ type: 'setPassword', playerId: null, password });
  }

  clearBans(): void {
    this.actions.push({ type: 'clearBans', playerId: null });
  }

  clearBan(playerId: number): void {
    this.actions.push({ type: 'clearBan', playerId });
  }

  /** Null gives the player back the avatar they chose. */
  overrideAvatar(playerId: number, avatar: string | null): void {
    this.actions.push({ type: 'overrideAvatar', playerId, avatar });
  }

  /** `conn` identifies the network address the player connected from. */
  peerInfo(playerId: number): { auth: string; conn: string } | undefined {
    const peer = this.peerOf(playerId);
    return peer === undefined ? undefined : { auth: peer.auth, conn: peer.conn };
  }

  addPeer(transport: Transport, conn = '', captcha = false): PeerHandle {
    const peer: Peer = {
      transport,
      playerId: null,
      join: null,
      nonce: toBase64url(crypto.getRandomValues(new Uint8Array(32))),
      auth: '',
      conn,
      captcha,
      lastSeen: performance.now(),
      rttMs: 0,
      lastInputTick: 0,
      chatTokens: this.chatRateLimit.burst,
      chatRefillTick: this.tick,
      chatQueue: [],
      messages: 0,
      lastResyncTick: -Infinity,
    };
    this.peers.add(peer);
    this.hadPeer = true;
    this.send(peer, { type: 'challenge', nonce: peer.nonce });
    return {
      receive: (data) => this.receive(peer, data),
      closed: () => this.drop(peer),
    };
  }

  close(): void {
    this.stop();
    for (const peer of this.peers) {
      this.send(peer, { type: 'disconnected', reason: 'closed' });
      peer.transport.close();
    }
    this.peers.clear();
  }

  private send(peer: Peer, msg: ServerMessage): void {
    peer.transport.send(encodeServerMessage(msg));
  }

  private reject(peer: Peer, reason: Extract<ServerMessage, { type: 'joinRejected' }>['reason']): void {
    this.send(peer, { type: 'joinRejected', reason });
    this.peers.delete(peer);
    peer.transport.close();
    this.checkEmpty();
  }

  private disconnect(peer: Peer, reason: string): void {
    this.send(peer, { type: 'disconnected', reason });
    peer.transport.close();
    this.drop(peer);
  }

  private drop(peer: Peer): void {
    if (!this.peers.delete(peer)) return;
    if (peer.playerId !== null) this.actions.push({ type: 'leave', playerId: peer.playerId });
    this.checkEmpty();
  }

  private checkEmpty(): void {
    if (this.onEmpty === undefined || !this.hadPeer || this.emptied || this.peers.size > 0 || this.state.players.length > 0 || this.actions.some((a) => a.type === 'leave')) return;
    this.emptied = true;
    this.stop();
    this.onEmpty();
  }

  private receive(peer: Peer, data: Uint8Array | ArrayBuffer): void {
    if (!this.peers.has(peer)) return;
    peer.lastSeen = performance.now();
    if (++peer.messages > MAX_MESSAGES_PER_SECOND) {
      if (peer.conn !== '') this.floodBans.set(peer.conn, this.tick + FLOOD_BAN_TICKS);
      this.disconnect(peer, 'flood');
      return;
    }
    let msg: ClientMessage;
    try {
      msg = decodeClientMessage(data);
    } catch {
      const version = joinVersion(data);
      if (peer.playerId === null) this.reject(peer, version !== null && version !== PROTOCOL_VERSION ? 'version' : 'invalid');
      else this.disconnect(peer, 'invalid message');
      return;
    }
    if (msg.type === 'pong') {
      peer.rttMs = Math.max(0, performance.now() - msg.t);
      return;
    }
    if (peer.playerId === null) {
      if (msg.type === 'join' && peer.join === null) this.requestJoin(peer, msg);
      return;
    }
    const playerId = peer.playerId;
    switch (msg.type) {
      case 'join':
        break;
      case 'resync':
        if (this.tick - peer.lastResyncTick < HASH_INTERVAL) break;
        peer.lastResyncTick = this.tick;
        this.actions.push({ type: 'resync', peer });
        break;
      case 'input': {
        const tick = Math.max(Math.min(Math.max(msg.tick, this.tick + 1), this.tick + MAX_INPUT_LEAD), peer.lastInputTick);
        peer.lastInputTick = tick;
        let list = this.inputs.get(tick);
        if (list === undefined) this.inputs.set(tick, (list = []));
        list.push({ playerId, input: msg.input & inputMask(this.state) });
        break;
      }
      case 'chat':
        this.actions.push({ type: 'chat', playerId, text: msg.text });
        break;
      case 'setPassword':
        this.actions.push({ type: 'setPassword', playerId, password: msg.password });
        break;
      case 'clearBans':
        this.actions.push({ type: 'clearBans', playerId });
        break;
      case 'request':
        this.actions.push({ type: 'request', playerId, event: msg.event });
        break;
    }
  }

  private pendingJoins(): number {
    let n = 0;
    for (const a of this.actions) if (a.type === 'join') n++;
    return n;
  }

  /** How many players one network address may have in the room; Infinity for no limit. */
  setMaxPlayersPerConn(limit: number): void {
    this.maxPlayersPerConn = limit;
  }

  /**
   * Turns away joiners whose connection came without a captcha the lobby verified. Where the lobby verifies none,
   * the join limit drops to one attempt per connection every 30 seconds instead.
   */
  setRequireCaptcha(required: boolean): void {
    this.requireCaptcha = required;
  }

  /** Takes the lobby's list of auths banned everywhere, and disconnects players on it who are already in. */
  setGlobalBans(auths: ReadonlySet<string>): void {
    this.globalBans = auths;
    for (const peer of [...this.peers]) if (peer.auth !== '' && auths.has(peer.auth)) this.disconnect(peer, 'banned');
  }

  /** The lobby's key that vouches for identities which solved a captcha; such joiners skip the room's captcha. */
  setVerifyKey(key: Uint8Array | null): void {
    this.verifyKey = key;
  }

  /** Whether `verified` is the lobby's unexpired proof for `auth`. */
  private isVerified(auth: string, verified: string): boolean {
    if (this.verifyKey === null || auth === '') return false;
    const [expires, signature] = verified.split('.');
    const until = Number(expires);
    if (signature === undefined || !Number.isInteger(until) || until * 1000 < Date.now()) return false;
    try {
      return verifyP256(this.verifyKey, new TextEncoder().encode(verifiedMessage(auth, until)), fromBase64url(signature));
    } catch {
      return false;
    }
  }

  /** Whether the lobby serving the room verifies captchas. */
  setCaptchaAvailable(available: boolean): void {
    this.captchaAvailable = available;
  }

  /** Null turns off the automatic guard against join bursts. */
  setRaidProtection(raid: RaidProtection | null): void {
    this.raid = raid;
    if (raid === null) this.raidUntil = -Infinity;
  }

  /** The host asked for the guard, or a join burst turned it on. */
  private get guarded(): boolean {
    return this.requireCaptcha || this.raidUntil > this.tick;
  }

  get captchaRequired(): boolean {
    return this.guarded && this.captchaAvailable;
  }

  /** Counts a join of a new key from another connection and turns the guard on when they come in a burst. */
  private watchRaid(auth: string): void {
    const known = auth !== '' && this.seenAuths.has(auth);
    if (auth !== '') {
      if (this.seenAuths.size >= MAX_SEEN_AUTHS) this.seenAuths.clear();
      this.seenAuths.add(auth);
    }
    if (this.raid === null || known || this.tick < RAID_GRACE_TICKS) return;
    const { joins, seconds, minutes } = this.raid;
    this.recentJoins = this.recentJoins.filter((t) => this.tick - t < seconds * TICKS_PER_SECOND);
    this.recentJoins.push(this.tick);
    if (this.recentJoins.length < joins || this.raidUntil > this.tick) return;
    this.raidUntil = this.tick + minutes * 60 * TICKS_PER_SECOND;
    const guard = this.captchaAvailable ? 'must solve a captcha' : 'get one join attempt every 30 seconds';
    this.hostEvent({ type: 'announcement', text: `Many players joined at once: for ${minutes} minutes new players ${guard}.`, targetId: null, color: 0xffc94d, style: 'bold', sound: 2 });
  }

  /** The in-process host and rooms without a lobby have no connection to limit. */
  private allowJoinAttempt(conn: string): boolean {
    if (conn === '') return true;
    const { attempts, windowTicks } = this.guarded && !this.captchaAvailable ? STRICT_JOIN_LIMIT : JOIN_LIMIT;
    const recent = (this.joinAttempts.get(conn) ?? []).filter((t) => this.tick - t < windowTicks);
    const allowed = recent.length < attempts;
    if (allowed) recent.push(this.tick);
    this.joinAttempts.set(conn, recent);
    return allowed;
  }

  private requestJoin(peer: Peer, msg: JoinMessage): void {
    if (msg.name === '') return this.reject(peer, 'invalid');
    const gated = this.captchaRequired && peer.conn !== '' && !peer.captcha;
    // Before the join limit, so a joiner sent off to solve the captcha keeps its attempts for coming back.
    if (gated && msg.verified === '') return this.reject(peer, 'captcha');
    if ((this.floodBans.get(peer.conn) ?? -Infinity) > this.tick || !this.allowJoinAttempt(peer.conn)) return this.reject(peer, 'rateLimited');
    // Signatures are checked only past the join limit, so join floods cannot spend the room's time on them.
    const auth = verifiedAuth(msg.auth, msg.signature, peer.nonce);
    if (gated && !this.isVerified(auth, msg.verified)) return this.reject(peer, 'captcha');
    if (auth !== '' && this.globalBans.has(auth)) return this.reject(peer, 'banned');
    for (const ban of this.bans.values()) if ((auth !== '' && ban.auth === auth) || (peer.conn !== '' && ban.conn === peer.conn)) return this.reject(peer, 'banned');
    if (this.created && this.password !== '' && msg.password !== this.password) return this.reject(peer, 'password');
    // Only the key's holder can sign as it, so the newer connection replaces the older one: a reconnect, or one tab too many.
    // The in-process host is never replaced, since closing it closes the room.
    const holds = (p: Peer) => p !== peer && (p.playerId !== null || p.join !== null);
    const previous = auth === '' ? undefined : [...this.peers].find((p) => holds(p) && p.auth === auth && p.conn !== '');
    let fromConn = 0;
    for (const p of this.peers) if (holds(p) && p !== previous && p.conn === peer.conn) fromConn++;
    if (peer.conn !== '' && fromConn >= this.maxPlayersPerConn) return this.reject(peer, 'connLimit');
    if (this.state.players.length + this.pendingJoins() - (previous === undefined ? 0 : 1) >= this.state.maxPlayers) return this.reject(peer, 'full');
    if (previous !== undefined) this.disconnect(previous, 'joined again');
    if (!this.created) {
      this.created = true;
      this.password = msg.password;
      this.state.hasPassword = msg.password !== '';
    }
    peer.join = msg;
    peer.auth = auth;
    this.actions.push({ type: 'join', peer });
    if (peer.conn !== '') this.watchRaid(auth);
  }

  private player(id: number): RoomPlayer | undefined {
    return this.state.players.find((p) => p.id === id);
  }

  private isAdmin(id: number | null): boolean {
    return id === null || this.player(id)?.admin === true;
  }

  private peerOf(playerId: number): Peer | undefined {
    for (const peer of this.peers) if (peer.playerId === playerId) return peer;
    return undefined;
  }

  runTick(): void {
    const tick = ++this.tick;
    const events: RoomEvent[] = [];
    const targets = new Map<RoomEvent, number>();
    const emit = (ev: RoomEvent) => {
      applyEvent(this.state, ev);
      events.push(ev);
      this.hooks.onEvent?.(ev);
    };
    const welcomes: Peer[] = [];
    const kicked: { peer: Peer; reason: string }[] = [];
    const resyncs: Peer[] = [];

    for (const id of this.resynced.splice(0)) {
      if (this.player(id) !== undefined) emit({ type: 'syncChange', playerId: id, synced: true });
    }

    for (const { playerId, input } of this.inputs.get(tick) ?? []) {
      if (this.player(playerId) !== undefined) emit({ type: 'input', playerId, input });
    }
    this.inputs.delete(tick);

    for (const action of this.actions.splice(0)) {
      switch (action.type) {
        case 'join': {
          const { peer } = action;
          const join = peer.join;
          if (!this.peers.has(peer) || join === null) break;
          const player: RoomPlayer = {
            id: this.nextPlayerId++,
            name: join.name,
            team: Team.spectators,
            admin: this.autoAdmin && this.nextJoinSeq === 0,
            avatar: join.avatar,
            country: join.country,
            joinSeq: this.nextJoinSeq++,
            ping: 0,
          };
          peer.playerId = player.id;
          emit({ type: 'playerJoin', player });
          peer.lastInputTick = tick;
          welcomes.push(peer);
          break;
        }
        case 'leave':
          if (this.player(action.playerId) === undefined) break;
          emit({ type: 'playerLeave', playerId: action.playerId, kicked: false, ban: false, reason: '', byPlayer: null });
          this.handOverAdmin(emit);
          break;
        case 'chat':
          this.queueChat(action.playerId, action.text, emit);
          break;
        case 'resync':
          if (!this.peers.has(action.peer) || action.peer.playerId === null) break;
          emit({ type: 'syncChange', playerId: action.peer.playerId, synced: false });
          resyncs.push(action.peer);
          break;
        case 'setPassword':
          if (!this.isAdmin(action.playerId)) break;
          if (action.password !== null && (action.password === '' || [...action.password].length > LIMITS.password)) break;
          this.password = action.password ?? '';
          emit({ type: 'setPassword', hasPassword: action.password !== null, byPlayer: action.playerId });
          break;
        case 'clearBans':
          if (this.isAdmin(action.playerId)) this.bans.clear();
          break;
        case 'clearBan':
          this.bans.delete(action.playerId);
          break;
        case 'overrideAvatar':
          this.overrideAvatarNow(action.playerId, action.avatar, emit);
          break;
        case 'request': {
          const ev = this.validate(action.playerId, action.event);
          if (ev !== null) this.apply(ev, emit, kicked);
          break;
        }
        case 'host': {
          const ev = this.validate(null, action.event);
          if (ev === null) break;
          if (!readable(ev)) {
            console.warn(`Dropped a ${ev.type} event with values clients cannot read`);
            break;
          }
          if (action.targetId !== null) targets.set(ev, action.targetId);
          this.apply(ev, emit, kicked);
          break;
        }
      }
    }

    for (const peer of this.peers) this.drainChat(peer, emit);

    if (tick % PING_EVENT_INTERVAL === 0 && this.state.players.length > 0) {
      const pings: [number, number][] = [];
      for (const peer of this.peers) if (peer.playerId !== null && this.player(peer.playerId) !== undefined) pings.push([peer.playerId, Math.min(Math.round(peer.rttMs), 0xffffffff)]);
      emit({ type: 'ping', pings });
    }

    const game = this.state.game;
    const simulated = game !== null && game.pauseCounter === 0;
    const outcomes = stepRoom(this.state, this.hooks.onCollision);
    this.hooks.onStep?.(outcomes, simulated);

    const ready = [...this.peers].filter((p) => p.playerId !== null && !welcomes.includes(p));
    if (targets.size === 0) {
      const batch = encodeServerMessage({ type: 'events', tick, events });
      for (const peer of ready) peer.transport.send(batch);
    } else {
      for (const peer of ready) {
        const own = events.filter((ev) => {
          const target = targets.get(ev);
          return target === undefined || target === peer.playerId;
        });
        this.send(peer, { type: 'events', tick, events: own });
      }
    }
    for (const peer of welcomes) this.send(peer, { type: 'welcome', playerId: peer.playerId as number, tick, room: this.state });
    for (const peer of resyncs) {
      this.send(peer, { type: 'snapshot', tick, room: this.state });
      this.resynced.push(peer.playerId as number);
    }
    if (tick % HASH_INTERVAL === 0) {
      const hash = encodeServerMessage({ type: 'hash', tick, hash: hashRoom(this.state) });
      for (const peer of this.peers) if (peer.playerId !== null) peer.transport.send(hash);
    }
    for (const { peer, reason } of kicked) {
      peer.playerId = null;
      this.disconnect(peer, reason);
    }

    const now = performance.now();
    for (const peer of [...this.peers]) {
      if (now - peer.lastSeen > this.timeoutMs) this.disconnect(peer, 'timeout');
    }
    if (tick % PING_INTERVAL === 0) {
      for (const [conn, ticks] of this.joinAttempts) if (ticks.every((t) => tick - t >= JOIN_LIMIT.windowTicks)) this.joinAttempts.delete(conn);
      for (const [conn, until] of this.floodBans) if (until <= tick) this.floodBans.delete(conn);
      for (const peer of this.peers) {
        peer.messages = 0;
        this.send(peer, { type: 'ping', t: now });
      }
    }
    this.checkEmpty();
  }

  private apply(ev: RoomEvent, emit: (ev: RoomEvent) => void, kicked: { peer: Peer; reason: string }[]): void {
    if (ev.type !== 'playerLeave') {
      emit(ev);
      return;
    }
    const target = this.peerOf(ev.playerId);
    if (ev.ban && target !== undefined) this.bans.set(ev.playerId, { auth: target.auth, conn: target.conn });
    emit(ev);
    if (target !== undefined) kicked.push({ peer: target, reason: ev.ban ? 'banned' : 'kicked' });
    this.handOverAdmin(emit);
  }

  private handOverAdmin(emit: (ev: RoomEvent) => void): void {
    const players = this.state.players;
    if (!this.autoAdmin || players.length === 0 || players.some((p) => p.admin)) return;
    const oldest = players.reduce((a, b) => (b.joinSeq < a.joinSeq ? b : a));
    emit({ type: 'setAdmin', playerId: oldest.id, admin: true, byPlayer: null });
  }

  private queueChat(playerId: number, text: string, emit: (ev: RoomEvent) => void): void {
    const peer = this.peerOf(playerId);
    if (peer === undefined || text.trim() === '' || /[\r\n]/.test(text) || peer.chatQueue.length >= MAX_CHAT_QUEUE) return;
    peer.chatQueue.push(text);
    this.drainChat(peer, emit);
  }

  /** Sends queued messages while the peer has chat tokens; one token comes back per interval. */
  private drainChat(peer: Peer, emit: (ev: RoomEvent) => void): void {
    const playerId = peer.playerId;
    if (playerId === null || peer.chatQueue.length === 0) return;
    const { burst, intervalTicks } = this.chatRateLimit;
    const regained = Math.floor((this.tick - peer.chatRefillTick) / intervalTicks);
    if (regained > 0) {
      peer.chatTokens = Math.min(burst, peer.chatTokens + regained);
      peer.chatRefillTick += regained * intervalTicks;
    }
    if (peer.chatTokens === burst) peer.chatRefillTick = this.tick;
    while (peer.chatTokens > 0 && peer.chatQueue.length > 0) {
      const text = peer.chatQueue.shift() as string;
      peer.chatTokens--;
      if (this.hooks.allowChat?.(playerId, text) !== false) emit({ type: 'chat', playerId, text });
    }
  }

  private overrideAvatarNow(playerId: number, avatar: string | null, emit: (ev: RoomEvent) => void): void {
    const player = this.player(playerId);
    if (player === undefined) return;
    if (avatar === null) {
      const own = this.ownAvatars.get(playerId);
      if (own === undefined) return;
      this.ownAvatars.delete(playerId);
      emit({ type: 'setAvatar', playerId, avatar: own });
      return;
    }
    if (!this.ownAvatars.has(playerId)) this.ownAvatars.set(playerId, player.avatar);
    emit({ type: 'setAvatar', playerId, avatar });
  }

  /** Returns the event to apply on behalf of `from` (null = host), or null when the request is not allowed. */
  private validate(from: number | null, ev: RoomEvent): RoomEvent | null {
    const admin = this.isAdmin(from);
    const host = from === null;
    const game = this.state.game;
    switch (ev.type) {
      case 'setTyping':
        return host || ev.playerId === from ? ev : null;
      case 'setAvatar':
        if (host) return ev;
        if (ev.playerId !== from) return null;
        if (!this.ownAvatars.has(from)) return ev;
        this.ownAvatars.set(from, ev.avatar);
        return null;
      case 'setTeam': {
        const target = this.player(ev.playerId);
        if (target === undefined || target.team === ev.team) return null;
        if (!admin && (ev.playerId !== from || this.state.teamsLock || game !== null)) return null;
        return { ...ev, byPlayer: from, announce: ev.announce && admin };
      }
      case 'setAdmin': {
        const target = this.player(ev.playerId);
        if (!admin || target === undefined || target.admin === ev.admin) return null;
        return { ...ev, byPlayer: from };
      }
      case 'playerLeave':
        if (!admin || ev.playerId === from || this.player(ev.playerId) === undefined) return null;
        return { ...ev, kicked: true, byPlayer: from };
      case 'startGame':
        return admin && game === null ? { ...ev, byPlayer: from } : null;
      case 'stopGame':
        return admin && game !== null ? { ...ev, byPlayer: from } : null;
      case 'setPaused':
        return admin && game !== null && ev.paused !== (game.pauseCounter === PAUSED) ? { ...ev, byPlayer: from } : null;
      case 'setStadium':
        if (!admin || game !== null) return null;
        try {
          parseStadium(ev.source);
        } catch {
          return null;
        }
        return { ...ev, byPlayer: from };
      case 'setScoreLimit':
      case 'setTimeLimit':
        if (host) {
          const value = Math.min(Math.max(Math.trunc(ev.value), 0), MAX_HOST_LIMIT);
          return game === null && !Number.isNaN(value) ? { ...ev, value } : null;
        }
        return admin && game === null && inRange(ev.value, 0, MAX_LIMIT) ? { ...ev, byPlayer: from } : null;
      case 'setTeamsLock':
        return admin ? { ...ev, byPlayer: from } : null;
      case 'setTeamColors':
        return admin && validColors(ev.colors) ? { ...ev, byPlayer: from } : null;
      case 'setHudItem': {
        if (!host || ev.id === '') return null;
        if (ev.item === null) return ev;
        const { x, y, size, color } = ev.item;
        const fits = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
        const full = this.state.hud.length >= LIMITS.hudItems && !this.state.hud.some((h) => h.id === ev.id);
        return fits(x) && fits(y) && inRange(size, 8, 64) && isColor(color) && !full ? ev : null;
      }
      case 'setCamera': {
        const { follow, zoom } = ev.camera;
        const target = follow === null || follow.type !== 'point' || (Number.isFinite(follow.x) && Number.isFinite(follow.y));
        return host && target && Number.isFinite(zoom) && zoom >= 0.25 && zoom <= 4 ? ev : null;
      }
      case 'setPlayerPhysics':
        return host && (ev.physics === null || Object.values(ev.physics).every((v) => v === undefined || Number.isFinite(v))) ? ev : null;
      case 'setPlayerColors':
        return host && (ev.colors === null || validColors(ev.colors)) ? ev : null;
      case 'setActionKeys':
        return host ? ev : null;
      case 'setKickRateLimit': {
        const { min, rate, burst } = ev.limit;
        const valid = inRange(min, 0, 255) && inRange(rate, 0, 255) && inRange(burst, 0, 100);
        return admin && valid ? { ...ev, byPlayer: from } : null;
      }
      case 'addJoint': {
        if (!host || game === null || game.joints.length >= MAX_JOINTS) return null;
        const { a, b, length, strength, color, breakLength } = ev.joint;
        const end = (e: JointEnd) => ('disc' in e ? inRange(e.disc, 0, game.discs.length - 1) : game.players.some((p) => p.id === e.player));
        const lengths = length === null || (Number.isFinite(length[0]) && Number.isFinite(length[1]) && length[0] >= 0 && length[0] <= length[1]);
        const positive = (v: number) => v === Infinity || (Number.isFinite(v) && v >= 0);
        return end(a) && end(b) && lengths && positive(strength) && positive(breakLength) && (color === -1 || isColor(color)) ? ev : null;
      }
      case 'removeJoint':
        return host && game !== null && inRange(ev.index, 0, game.joints.length - 1) ? ev : null;
      case 'setRoomProps':
        return host && (ev.maxPlayers === null || inRange(ev.maxPlayers, MIN_PLAYERS, MAX_PLAYERS)) ? ev : null;
      case 'setTeamName':
        return host ? ev : null;
      case 'setGameProps': {
        const { red, blue, time, scoreLimit, timeLimit } = ev;
        const count = (v: number | null, max: number) => v === null || inRange(v, 0, max);
        const fits = count(red, MAX_SCORE) && count(blue, MAX_SCORE) && count(scoreLimit, MAX_HOST_LIMIT) && count(timeLimit, MAX_HOST_LIMIT);
        return host && game !== null && fits && (time === null || (Number.isFinite(time) && time >= 0)) ? ev : null;
      }
      case 'playerJoin':
      case 'chat':
      case 'announcement':
      case 'reorderPlayers':
      case 'setDiscProperties':
      case 'setPlayerDiscProperties':
        return host ? ev : null;
      case 'input':
      case 'setPassword':
      case 'ping':
      case 'syncChange':
        return null;
    }
  }
}
