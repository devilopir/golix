// Types shared by every package.

export interface Vec2 {
  x: number;
  y: number;
}

// Values match the Headless Host API so community scripts keep working.
export const CollisionFlags = {
  ball: 1,
  red: 2,
  blue: 4,
  redKO: 8,
  blueKO: 16,
  wall: 32,
  all: 63,
  kick: 64,
  score: 128,
  c0: 0x10000000,
  c1: 0x20000000,
  c2: 0x40000000,
  // 1 << 31: the sign bit, negative as a 32-bit integer.
  c3: -0x80000000,
} as const;
export type CollisionFlagName = keyof typeof CollisionFlags;

export const InputFlags = {
  up: 1,
  down: 2,
  left: 4,
  right: 8,
  kick: 16,
} as const;
/** Golix only: input bits of the script-defined action keys 1 to 6, above the original's; no built-in effect. */
export const ActionFlags = [32, 64, 128, 256, 512, 1024] as const;
/** Bitmask of InputFlags, plus ActionFlags in rooms that turned action keys on. */
export type Input = number;

export const Team = {
  spectators: 0,
  red: 1,
  blue: 2,
} as const;
export type Team = (typeof Team)[keyof typeof Team];
export type PlayingTeam = typeof Team.red | typeof Team.blue;

/** 0xRRGGBB, or -1 for "transparent". */
export type Color = number;

// Resolved stadium (parser output, physics input). All defaults and traits applied.

export interface PlayerPhysics {
  radius: number;
  bCoef: number;
  invMass: number;
  damping: number;
  cGroup: number;
  acceleration: number;
  kickingAcceleration: number;
  kickingDamping: number;
  kickStrength: number;
  kickback: number;
  gravity: Vec2;
}

/** Golix only: the PlayerPhysics fields a host may change for one player. */
export const PLAYER_PHYSICS_KEYS = ['radius', 'bCoef', 'invMass', 'damping', 'acceleration', 'kickingAcceleration', 'kickingDamping', 'kickStrength', 'kickback'] as const;
/** Fields left out keep the stadium's value. */
export type PlayerPhysicsOverrides = Partial<Record<(typeof PLAYER_PHYSICS_KEYS)[number], number>>;

export interface Disc {
  pos: Vec2;
  speed: Vec2;
  gravity: Vec2;
  radius: number;
  invMass: number;
  damping: number;
  bCoef: number;
  color: Color;
  cGroup: number;
  cMask: number;
}

export interface Vertex {
  pos: Vec2;
  bCoef: number;
  cGroup: number;
  cMask: number;
}

export interface Segment {
  v0: number;
  v1: number;
  bCoef: number;
  cGroup: number;
  cMask: number;
  bias: number;
  vis: boolean;
  color: Color;
  /** Cotangent of half the curve angle; Infinity = straight. v0/v1 and bias are already swapped for negative curves. */
  curveF: number;
  /** Straight segments: unit normal. Null when curved. */
  normal: Vec2 | null;
  /** Curved segments: arc circle and the two tangent limits of the arc, computed at load time. */
  arc: {
    center: Vec2;
    radius: number;
    tan0: Vec2;
    tan1: Vec2;
  } | null;
}

export interface Plane {
  /** Unit normal. */
  normal: Vec2;
  dist: number;
  bCoef: number;
  cGroup: number;
  cMask: number;
}

export interface Goal {
  p0: Vec2;
  p1: Vec2;
  /** Team that concedes when the ball crosses this line. */
  team: PlayingTeam;
}

export interface Joint {
  d0: number;
  d1: number;
  minLength: number;
  maxLength: number;
  /** Infinity = rigid, otherwise spring coefficient. */
  strength: number;
  color: Color;
  /** Golix only: the joint breaks once its discs are farther apart than this; Infinity = never. */
  breakLength: number;
}

/** Golix only: one end of a joint in a running game: a stadium disc by index, or the disc of the player with that id. */
export type JointEnd = { disc: number } | { player: number };

/** A joint of the running game: the stadium's own, then those a host script added; a player end without a disc does nothing. */
export interface GameJoint extends Omit<Joint, 'd0' | 'd1'> {
  a: JointEnd;
  b: JointEnd;
}

export type BackgroundType = 'grass' | 'hockey' | 'none';

export interface Background {
  type: BackgroundType;
  width: number;
  height: number;
  kickOffRadius: number;
  cornerRadius: number;
  goalLine: number;
  color: Color;
}

export interface Stadium {
  name: string;
  width: number;
  height: number;
  maxViewWidth: number;
  cameraFollow: 'ball' | 'player';
  spawnDistance: number;
  canBeStored: boolean;
  kickOffReset: 'partial' | 'full';
  bg: Background;
  vertexes: Vertex[];
  segments: Segment[];
  goals: Goal[];
  /** discs[0] is always the ball. */
  discs: Disc[];
  planes: Plane[];
  joints: Joint[];
  redSpawnPoints: Vec2[];
  blueSpawnPoints: Vec2[];
  playerPhysics: PlayerPhysics;
}

// Simulation state (deterministic, owned by packages/shared).

export type GamePhase = 'kickoff' | 'playing' | 'goal' | 'ended';

export interface SimPlayer {
  id: number;
  team: Team;
  input: Input;
  /** Latched kick intent: set on the kick key's 0→1 edge, cleared by a landed kick or by releasing the key. */
  kicking: boolean;
  kickCooldown: number;
  kickTokens: number;
  /** Null for spectators. */
  disc: Disc | null;
}

export interface GameState {
  tick: number;
  phase: GamePhase;
  /** Ticks elapsed in the current phase. */
  phaseTicks: number;
  /** 120 while paused; counts down to 0 after unpause, physics frozen while > 0. */
  pauseCounter: number;
  red: number;
  blue: number;
  /** Game clock in seconds, accumulated as += 1/60 per playing tick like the original (float rounding included). */
  time: number;
  overtime: boolean;
  kickoffTeam: PlayingTeam;
  /** Team that scored the last goal, while phase === 'goal'. */
  scoringTeam: PlayingTeam | null;
  /** Winner, while phase === 'ended'. */
  winner: PlayingTeam | null;
  scoreLimit: number;
  /** Minutes; 0 = unlimited. */
  timeLimit: number;
  stadium: Stadium;
  /** Stadium discs (0 = ball), mutated in place each tick. */
  discs: Disc[];
  /** Same order as RoomState.players; processing order is part of determinism. */
  players: SimPlayer[];
  /** Replaced, never edited in place, when one is added, removed or breaks. */
  joints: GameJoint[];
}

// Room state (replicated through events).

export interface TeamColors {
  /** Degrees, 0 to 360. */
  angle: number;
  textColor: Color;
  /** Up to LIMITS.teamColors stripe colors; none = the default kit. */
  colors: Color[];
}

export interface RoomPlayer {
  id: number;
  name: string;
  team: Team;
  admin: boolean;
  /** Empty = default (number). */
  avatar: string;
  country: string;
  /** Join order; used for admin hand-over and spawn order. */
  joinSeq: number;
  ping: number;
  /** Golix only: the player's own kit, drawn instead of the team's; set by the host. */
  colors?: TeamColors;
  /** Golix only: the host's changes to the stadium's player physics for this player; they last across kickoffs. */
  physics?: PlayerPhysicsOverrides;
}

export interface KickRateLimit {
  min: number;
  rate: number;
  burst: number;
}

export interface RoomState {
  name: string;
  maxPlayers: number;
  hasPassword: boolean;
  players: RoomPlayer[];
  teamsLock: boolean;
  scoreLimit: number;
  timeLimit: number;
  redColors: TeamColors;
  blueColors: TeamColors;
  /** Golix only: the host's names for the teams; empty = "Red" and "Blue". */
  redName: string;
  blueName: string;
  /** .hbs source text; every peer parses it, so the parser must be deterministic. */
  stadiumSource: string;
  kickRateLimit: KickRateLimit;
  /** Golix only: whether players send the action keys; off unless the host's script turns them on. */
  actionKeys: boolean;
  /** Golix only: the host's text on the game screen, drawn in this order. */
  hud: HudItem[];
  /** Golix only: the host's camera; follow null keeps the usual one. */
  camera: CameraOverride;
  game: GameState | null;
}

/** Golix only: text a host script pins on every player's game screen. */
export interface HudItem {
  /** Names the item for later changes; up to LIMITS.hudId characters. */
  id: string;
  text: string;
  /** Anchor point as a fraction of the screen, from 0, 0 at the top left to 1, 1 at the bottom right. */
  x: number;
  y: number;
  align: 'left' | 'center' | 'right';
  color: number;
  /** Font size in CSS pixels, 8 to 64. */
  size: number;
}

/** Golix only: what the camera follows instead of the ball and the player. */
export type CameraFollow = { type: 'player'; id: number } | { type: 'disc'; index: number } | { type: 'point'; x: number; y: number };

export interface CameraOverride {
  follow: CameraFollow | null;
  /** Multiplies the player's own zoom; 1 leaves it alone. */
  zoom: number;
}

/** Same shape as the Headless Host API DiscPropertiesObject; null fields are left unchanged. */
export interface DiscProperties {
  x: number | null;
  y: number | null;
  xspeed: number | null;
  yspeed: number | null;
  xgravity: number | null;
  ygravity: number | null;
  radius: number | null;
  bCoeff: number | null;
  invMass: number | null;
  damping: number | null;
  color: Color | null;
  cMask: number | null;
  cGroup: number | null;
}

// Events: the only way room/game state changes. Ordered by tick, applied identically everywhere.

/** byPlayer = null when the host/server caused it. */
export type RoomEvent =
  | { type: 'input'; playerId: number; input: Input }
  | { type: 'playerJoin'; player: RoomPlayer }
  | { type: 'playerLeave'; playerId: number; kicked: boolean; ban: boolean; reason: string; byPlayer: number | null }
  | { type: 'chat'; playerId: number; text: string }
  | { type: 'announcement'; text: string; targetId: number | null; color: Color; style: 'normal' | 'bold' | 'italic' | 'small' | 'small-bold' | 'small-italic'; sound: 0 | 1 | 2 }
  /** announce: an admin dragged the player; only then do clients print a notice. */
  | { type: 'setTeam'; playerId: number; team: Team; byPlayer: number | null; announce: boolean }
  | { type: 'setAdmin'; playerId: number; admin: boolean; byPlayer: number | null }
  | { type: 'setAvatar'; playerId: number; avatar: string }
  | { type: 'reorderPlayers'; playerIds: number[]; moveToTop: boolean }
  | { type: 'startGame'; byPlayer: number | null }
  | { type: 'stopGame'; byPlayer: number | null }
  | { type: 'setPaused'; paused: boolean; byPlayer: number | null }
  | { type: 'setStadium'; source: string; byPlayer: number | null }
  | { type: 'setScoreLimit'; value: number; byPlayer: number | null }
  | { type: 'setTimeLimit'; value: number; byPlayer: number | null }
  | { type: 'setTeamsLock'; locked: boolean; byPlayer: number | null }
  | { type: 'setTeamColors'; team: PlayingTeam; colors: TeamColors; byPlayer: number | null }
  /** Host only; null goes back to the team's kit. */
  | { type: 'setPlayerColors'; playerId: number; colors: TeamColors | null }
  | { type: 'setPlayerPhysics'; playerId: number; physics: PlayerPhysicsOverrides | null }
  /** Replaces the item with that id, adds it at the end, or with item null removes it. */
  | { type: 'setHudItem'; id: string; item: Omit<HudItem, 'id'> | null }
  | { type: 'setCamera'; camera: CameraOverride }
  /** Host only. */
  | { type: 'setActionKeys'; enabled: boolean }
  | { type: 'setKickRateLimit'; limit: KickRateLimit; byPlayer: number | null }
  | { type: 'setDiscProperties'; discIndex: number; props: DiscProperties }
  | { type: 'setPlayerDiscProperties'; playerId: number; props: DiscProperties }
  /** Host only; length null keeps the ends at their distance when the event applies. */
  | { type: 'addJoint'; joint: Omit<GameJoint, 'minLength' | 'maxLength'> & { length: [min: number, max: number] | null } }
  /** Host only. */
  | { type: 'removeJoint'; index: number }
  /** Host only; null fields are left unchanged. */
  | { type: 'setRoomProps'; name: string | null; maxPlayers: number | null }
  /** Host only; empty goes back to "Red" or "Blue". */
  | { type: 'setTeamName'; team: PlayingTeam; name: string }
  /** Host only, for the running game; null fields are left unchanged. time is the clock in seconds, timeLimit in minutes. */
  | { type: 'setGameProps'; red: number | null; blue: number | null; time: number | null; scoreLimit: number | null; timeLimit: number | null }
  | { type: 'setPassword'; hasPassword: boolean; byPlayer: number | null }
  | { type: 'setTyping'; playerId: number; typing: boolean }
  | { type: 'ping'; pings: [playerId: number, ms: number][] }
  /** False when the player asked for a resync, true once its snapshot went out. */
  | { type: 'syncChange'; playerId: number; synced: boolean };

// Wire protocol.

export type ClientMessage =
  /** signature: base64url ECDSA P-256 SHA-256 signature (r||s) of the challenge nonce by the auth key. */
  /** `verified` is the lobby's proof that `auth` solved a captcha (see LobbyHost verification), or empty. */
  | { type: 'join'; name: string; avatar: string; country: string; password: string; auth: string; signature: string; verified: string }
  | { type: 'input'; tick: number; input: Input }
  /** Any command a player may request; server validates permissions before turning it into a RoomEvent. */
  | { type: 'request'; event: RoomEvent }
  | { type: 'chat'; text: string }
  | { type: 'pong'; t: number }
  /** Admin only; the password text never leaves the server, peers only see a setPassword event. */
  | { type: 'setPassword'; password: string | null }
  | { type: 'clearBans' }
  /** Asks the server for a snapshot after a desync. */
  | { type: 'resync' };

export type ServerMessage =
  /** First message on a connection; the join must sign the nonce. */
  | { type: 'challenge'; nonce: string }
  | { type: 'welcome'; playerId: number; tick: number; room: RoomState }
  | { type: 'joinRejected'; reason: 'password' | 'full' | 'banned' | 'invalid' | 'rateLimited' | 'captcha' | 'connLimit' | 'version' }
  /** Events confirmed for `tick`, in application order. */
  | { type: 'events'; tick: number; events: RoomEvent[] }
  | { type: 'hash'; tick: number; hash: number }
  | { type: 'snapshot'; tick: number; room: RoomState }
  | { type: 'ping'; t: number }
  | { type: 'disconnected'; reason: string };
