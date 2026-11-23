import JSON5 from 'json5';
import { tan } from '../math.ts';
import { CollisionFlags, Team } from '../types.ts';
import type {
  Background,
  BackgroundType,
  CollisionFlagName,
  Color,
  Disc,
  Goal,
  Joint,
  Plane,
  PlayerPhysics,
  Segment,
  Stadium,
  Vec2,
  Vertex,
} from '../types.ts';

export class StadiumError extends Error {
  readonly line: number | null;
  readonly column: number | null;
  readonly path: string | null;

  constructor(message: string, path: string | null, line: number | null = null, column: number | null = null) {
    super(path === null ? message : `${path}: ${message}`);
    this.name = 'StadiumError';
    this.path = path;
    this.line = line;
    this.column = column;
  }
}

type Obj = Record<string, unknown>;

// Curves at or below 9.99° or at or above 340° are treated as straight lines.
const CURVE_MIN = 0.17435839227423353;
const CURVE_MAX = 5.934119456780721;
/** Discs stay at the original's limit since each tick tests every pair; the other lists are cheap per object. */
const MAX_DISCS = 255;
const MAX_OBJECTS = 4096;

const DEFAULT_DISC: Disc = {
  pos: { x: 0, y: 0 },
  speed: { x: 0, y: 0 },
  gravity: { x: 0, y: 0 },
  radius: 10,
  invMass: 1,
  damping: 0.99,
  bCoef: 0.5,
  color: 0xffffff,
  cGroup: CollisionFlags.all,
  cMask: CollisionFlags.all,
};

const DEFAULT_BALL: Disc = { ...DEFAULT_DISC, cGroup: CollisionFlags.ball };

function fail(path: string, message: string): never {
  throw new StadiumError(message, path);
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asObj(v: unknown, path: string): Obj {
  return isObj(v) ? v : fail(path, 'expected an object');
}

// Like the original's casts: an optional field that is null counts as missing, any other wrong type fails the map.
function asNum(v: unknown, path: string): number {
  return typeof v === 'number' ? v : fail(path, 'expected a number');
}

/** A coordinate the original copies without a cast, so its arithmetic makes a missing one NaN and null 0. */
function coord(v: unknown, path: string): number {
  if (v === undefined) return NaN;
  if (v === null) return 0;
  return asNum(v, path);
}

function num(o: Obj, key: string, path: string, def?: number): number {
  const v = o[key];
  if (v == null && def !== undefined) return def;
  return asNum(v, join(path, key));
}

function bool(o: Obj, key: string, path: string, def: boolean): boolean {
  const v = o[key];
  if (v == null) return def;
  return typeof v === 'boolean' ? v : fail(join(path, key), 'expected true or false');
}

/** Like the original, any other value means the default. */
function choice<T extends string>(o: Obj, key: string, options: readonly T[], def: T): T {
  const v = o[key];
  return options.includes(v as T) ? (v as T) : def;
}

/** `loose` reads the elements the way the original does for disc vectors and goal points: without a cast. */
function asVec(v: unknown, path: string, loose = false): Vec2 {
  if (!Array.isArray(v)) return fail(path, 'expected [x, y]');
  const element = loose ? coord : asNum;
  return { x: element(v[0], `${path}[0]`), y: element(v[1], `${path}[1]`) };
}

function vec(o: Obj, key: string, path: string, def?: Vec2, loose = false): Vec2 {
  const v = o[key];
  if (v == null) return def === undefined ? fail(join(path, key), 'is required') : { ...def };
  return asVec(v, join(path, key), loose);
}

function index(o: Obj, key: string, path: string, count: number): number {
  const v = o[key];
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < count ? (v as number) : fail(join(path, key), `index ${v} out of range (0..${count - 1})`);
}

// Unknown names and non-string entries count as no flag, as in the original: published maps use "", "none" and "c4".
function flags(o: Obj, key: string, path: string, def: number): number {
  const v = o[key];
  if (v == null) return def;
  const names = typeof v === 'string' ? [v] : Array.isArray(v) ? v : fail(join(path, key), 'expected a list of flag names');
  let mask = 0;
  for (const name of names) if (typeof name === 'string' && Object.hasOwn(CollisionFlags, name)) mask |= CollisionFlags[name as CollisionFlagName];
  return mask;
}

/** Hex goes through parseInt("0x" + text) as in the original, so any length works and unreadable text is black. */
function color(o: Obj, key: string, path: string, def: Color): Color {
  const v = o[key];
  if (v == null) return def;
  if (v === 'transparent') return -1;
  if (typeof v === 'string') {
    const n = parseInt(`0x${v}`, 16);
    return Number.isNaN(n) ? 0 : n & 0xffffff;
  }
  if (Array.isArray(v)) return (((Number(v[0]) | 0) << 16) + ((Number(v[1]) | 0) << 8) + (Number(v[2]) | 0)) & 0xffffff;
  return fail(join(path, key), 'expected "RRGGBB", [r, g, b] or "transparent"');
}

function list(root: Obj, key: string): unknown[] {
  const v = root[key];
  if (v == null) return [];
  return Array.isArray(v) ? v : fail(key, 'expected a list');
}

/** The trait fills the fields the object leaves missing or null; an unknown trait adds nothing. */
function withTrait(raw: unknown, path: string, traits: Obj): Obj {
  const o = asObj(raw, path);
  if (o.trait == null || !Object.hasOwn(traits, String(o.trait))) return o;
  const trait = traits[String(o.trait)];
  if (!isObj(trait)) return o;
  const filled = { ...o };
  for (const [k, v] of Object.entries(trait)) if (filled[k] == null) filled[k] = v;
  return filled;
}

function parseDisc(o: Obj, p: string, def: Disc): Disc {
  return {
    pos: vec(o, 'pos', p, def.pos, true),
    speed: vec(o, 'speed', p, def.speed, true),
    gravity: vec(o, 'gravity', p, def.gravity, true),
    radius: num(o, 'radius', p, def.radius),
    invMass: num(o, 'invMass', p, def.invMass),
    damping: num(o, 'damping', p, def.damping),
    bCoef: num(o, 'bCoef', p, def.bCoef),
    color: color(o, 'color', p, def.color),
    cGroup: flags(o, 'cGroup', p, def.cGroup),
    cMask: flags(o, 'cMask', p, def.cMask),
  };
}

function parseSegment(o: Obj, p: string, vertexes: Vertex[]): Segment {
  let v0 = index(o, 'v0', p, vertexes.length);
  let v1 = index(o, 'v1', p, vertexes.length);
  let bias = num(o, 'bias', p, 0);
  let curveF: number;
  if (o.curveF != null) {
    curveF = asNum(o.curveF, join(p, 'curveF'));
  } else {
    let c = (num(o, 'curve', p, 0) * Math.PI) / 180;
    if (c < 0) {
      c = -c;
      [v0, v1] = [v1, v0];
      bias = -bias;
    }
    curveF = c > CURVE_MIN && c < CURVE_MAX ? 1 / tan(c / 2) : Infinity;
  }
  const a = vertexes[v0].pos;
  const b = vertexes[v1].pos;
  let normal: Vec2 | null = null;
  let arc: Segment['arc'] = null;
  if (Number.isFinite(curveF)) {
    const mx = 0.5 * (b.x - a.x);
    const my = 0.5 * (b.y - a.y);
    const center = { x: a.x + mx - my * curveF, y: a.y + my + mx * curveF };
    const dx = a.x - center.x;
    const dy = a.y - center.y;
    const s = curveF <= 0 ? -1 : 1;
    arc = {
      center,
      radius: Math.sqrt(dx * dx + dy * dy),
      tan0: { x: s * (center.y - a.y), y: s * (a.x - center.x) },
      tan1: { x: s * (b.y - center.y), y: s * (center.x - b.x) },
    };
  } else {
    const ex = a.x - b.x;
    const ey = a.y - b.y;
    const len = Math.sqrt(ex * ex + ey * ey);
    // A zero-length segment never passes the endpoint test in physics, so any normal works.
    normal = len === 0 ? { x: 0, y: 0 } : { x: -ey / len, y: ex / len };
  }
  return {
    v0,
    v1,
    bCoef: num(o, 'bCoef', p, 1),
    cGroup: flags(o, 'cGroup', p, CollisionFlags.wall),
    cMask: flags(o, 'cMask', p, CollisionFlags.all),
    bias,
    vis: bool(o, 'vis', p, true),
    color: color(o, 'color', p, 0),
    curveF,
    normal,
    arc,
  };
}

function parseJointLength(v: unknown, p: string, a: Disc, b: Disc): [number, number] {
  if (v == null) {
    const dx = a.pos.x - b.pos.x;
    const dy = a.pos.y - b.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    return [d, d];
  }
  if (typeof v === 'number') {
    const d = asNum(v, p);
    return [d, d];
  }
  if (Array.isArray(v)) return [asNum(v[0], `${p}[0]`), asNum(v[1], `${p}[1]`)];
  return fail(p, 'expected null, a number or [min, max]');
}

export function parseStadium(source: string): Stadium {
  let raw: unknown;
  try {
    raw = JSON5.parse(source);
  } catch (e) {
    const { message, lineNumber, columnNumber } = e as SyntaxError & { lineNumber?: number; columnNumber?: number };
    throw new StadiumError(message, null, lineNumber ?? null, columnNumber ?? null);
  }
  if (!isObj(raw)) throw new StadiumError('stadium must be an object', null);
  const root = raw;

  // The original takes `traits || {}`, so a list of traits works too, looked up by index.
  const traits: Obj = typeof root.traits === 'object' && root.traits !== null ? (root.traits as Obj) : {};
  const each = <T>(key: string, f: (o: Obj, path: string) => T): T[] => {
    const items = list(root, key);
    if (items.length > MAX_OBJECTS) fail(key, `has ${items.length} objects, the limit is ${MAX_OBJECTS}`);
    return items.map((r, i) => {
      const path = `${key}[${i}]`;
      return f(withTrait(r, path, traits), path);
    });
  };

  const vertexes = each<Vertex>('vertexes', (o, p) => ({
    pos: { x: num(o, 'x', p), y: num(o, 'y', p) },
    bCoef: num(o, 'bCoef', p, 1),
    cGroup: flags(o, 'cGroup', p, CollisionFlags.wall),
    cMask: flags(o, 'cMask', p, CollisionFlags.all),
  }));
  const segments = each('segments', (o, p) => parseSegment(o, p, vertexes));
  const goals = each<Goal>('goals', (o, p) => {
    if (o.team !== 'red' && o.team !== 'blue') fail(join(p, 'team'), 'expected "red" or "blue"');
    return { p0: asVec(o.p0, join(p, 'p0'), true), p1: asVec(o.p1, join(p, 'p1'), true), team: o.team === 'red' ? Team.red : Team.blue };
  });
  const planes = each<Plane>('planes', (o, p) => {
    const n = vec(o, 'normal', p);
    // A zero normal divides into NaN, a plane nothing collides with, as in the original.
    const len = Math.sqrt(n.x * n.x + n.y * n.y);
    return {
      normal: { x: n.x / len, y: n.y / len },
      dist: num(o, 'dist', p),
      bCoef: num(o, 'bCoef', p, 1),
      cGroup: flags(o, 'cGroup', p, CollisionFlags.wall),
      cMask: flags(o, 'cMask', p, CollisionFlags.all),
    };
  });

  const fileDiscs = each('discs', (o, p) => parseDisc(o, p, DEFAULT_DISC));
  let discs: Disc[];
  // The original compares with != "disc0", so ["disc0"] counts too; it applies no trait to ballPhysics.
  const { ballPhysics } = root;
  if (ballPhysics != null && String(ballPhysics) === 'disc0') {
    if (fileDiscs.length === 0) fail('ballPhysics', '"disc0" needs at least one disc');
    discs = fileDiscs;
  } else {
    const ball = parseDisc(isObj(ballPhysics) ? ballPhysics : {}, 'ballPhysics', DEFAULT_BALL);
    ball.cGroup |= CollisionFlags.kick | CollisionFlags.score;
    discs = [ball, ...fileDiscs];
  }
  if (discs.length > MAX_DISCS) fail('discs', `has ${discs.length} discs counting the ball, the limit is ${MAX_DISCS}`);

  const joints = each<Joint>('joints', (o, p) => {
    const d0 = index(o, 'd0', p, discs.length);
    const d1 = index(o, 'd1', p, discs.length);
    const [minLength, maxLength] = parseJointLength(o.length, join(p, 'length'), discs[d0], discs[d1]);
    const strength = o.strength == null || o.strength === 'rigid' ? Infinity : asNum(o.strength, join(p, 'strength'));
    const breakLength = o.breakLength == null ? Infinity : asNum(o.breakLength, join(p, 'breakLength'));
    return { d0, d1, minLength, maxLength, strength, color: color(o, 'color', p, 0), breakLength };
  });

  const spawns = (key: string): Vec2[] => list(root, key).map((v, i) => asVec(v, `${key}[${i}]`));

  const pp = isObj(root.playerPhysics) ? root.playerPhysics : {};
  const playerPhysics: PlayerPhysics = {
    radius: num(pp, 'radius', 'playerPhysics', 15),
    bCoef: num(pp, 'bCoef', 'playerPhysics', 0.5),
    invMass: num(pp, 'invMass', 'playerPhysics', 0.5),
    damping: num(pp, 'damping', 'playerPhysics', 0.96),
    cGroup: flags(pp, 'cGroup', 'playerPhysics', 0),
    acceleration: num(pp, 'acceleration', 'playerPhysics', 0.1),
    kickingAcceleration: num(pp, 'kickingAcceleration', 'playerPhysics', 0.07),
    kickingDamping: num(pp, 'kickingDamping', 'playerPhysics', 0.96),
    kickStrength: num(pp, 'kickStrength', 'playerPhysics', 5),
    kickback: num(pp, 'kickback', 'playerPhysics', 0),
    gravity: vec(pp, 'gravity', 'playerPhysics', { x: 0, y: 0 }),
  };

  const bgRaw = isObj(root.bg) ? root.bg : {};
  const bg: Background = {
    type: choice<BackgroundType>(bgRaw, 'type', ['grass', 'hockey', 'none'], 'none'),
    width: num(bgRaw, 'width', 'bg', 0),
    height: num(bgRaw, 'height', 'bg', 0),
    kickOffRadius: num(bgRaw, 'kickOffRadius', 'bg', 0),
    cornerRadius: num(bgRaw, 'cornerRadius', 'bg', 0),
    goalLine: num(bgRaw, 'goalLine', 'bg', 0),
    color: color(bgRaw, 'color', 'bg', 0x718c5a),
  };

  const name = root.name;
  return {
    name: typeof name === 'string' ? name : fail('name', 'expected a string'),
    width: num(root, 'width', ''),
    height: num(root, 'height', ''),
    // The original keeps it as an integer.
    maxViewWidth: num(root, 'maxViewWidth', '', 0) | 0,
    cameraFollow: choice(root, 'cameraFollow', ['ball', 'player'], 'ball'),
    spawnDistance: num(root, 'spawnDistance', '', 200),
    canBeStored: bool(root, 'canBeStored', '', true),
    kickOffReset: choice(root, 'kickOffReset', ['partial', 'full'], 'partial'),
    bg,
    vertexes,
    segments,
    goals,
    discs,
    planes,
    joints,
    redSpawnPoints: spawns('redSpawnPoints'),
    blueSpawnPoints: spawns('blueSpawnPoints'),
    playerPhysics,
  };
}
