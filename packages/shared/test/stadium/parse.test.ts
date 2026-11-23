import { describe, expect, test } from 'vitest';
import { StadiumError, parseStadium } from '../../src/stadium/parse.ts';
import { CollisionFlags } from '../../src/types.ts';

const base = { name: 'Test', width: 300, height: 200 };
const parse = (extra: object) => parseStadium(JSON.stringify({ ...base, ...extra }));

function parseError(source: string): StadiumError {
  try {
    parseStadium(source);
  } catch (e) {
    if (e instanceof StadiumError) return e;
    throw e;
  }
  throw new Error('expected a StadiumError');
}

const errorOf = (extra: object) => parseError(JSON.stringify({ ...base, ...extra }));

const square = [
  { x: -100, y: 0 },
  { x: 100, y: 0 },
];

describe('defaults', () => {
  test('a minimal stadium resolves every optional field', () => {
    const s = parse({});
    expect(s).toMatchObject({
      name: 'Test',
      width: 300,
      height: 200,
      maxViewWidth: 0,
      cameraFollow: 'ball',
      spawnDistance: 200,
      canBeStored: true,
      kickOffReset: 'partial',
      bg: { type: 'none', width: 0, height: 0, kickOffRadius: 0, cornerRadius: 0, goalLine: 0, color: 0x718c5a },
      vertexes: [],
      segments: [],
      goals: [],
      planes: [],
      joints: [],
      redSpawnPoints: [],
      blueSpawnPoints: [],
    });
    expect(s.playerPhysics).toEqual({
      radius: 15,
      bCoef: 0.5,
      invMass: 0.5,
      damping: 0.96,
      cGroup: 0,
      acceleration: 0.1,
      kickingAcceleration: 0.07,
      kickingDamping: 0.96,
      kickStrength: 5,
      kickback: 0,
      gravity: { x: 0, y: 0 },
    });
  });

  test('the default ball is discs[0] with ball|kick|score', () => {
    const s = parse({ discs: [{ pos: [5, 6] }] });
    expect(s.discs).toHaveLength(2);
    expect(s.discs[0]).toEqual({
      pos: { x: 0, y: 0 },
      speed: { x: 0, y: 0 },
      gravity: { x: 0, y: 0 },
      radius: 10,
      invMass: 1,
      damping: 0.99,
      bCoef: 0.5,
      color: 0xffffff,
      cGroup: CollisionFlags.ball | CollisionFlags.kick | CollisionFlags.score,
      cMask: CollisionFlags.all,
    });
    expect(s.discs[1]).toMatchObject({ pos: { x: 5, y: 6 }, cGroup: CollisionFlags.all, cMask: CollisionFlags.all });
  });

  test('vertex, segment and plane defaults', () => {
    const s = parse({ vertexes: square, segments: [{ v0: 0, v1: 1 }], planes: [{ normal: [0, 1], dist: -10 }] });
    expect(s.vertexes[0]).toEqual({ pos: { x: -100, y: 0 }, bCoef: 1, cGroup: CollisionFlags.wall, cMask: CollisionFlags.all });
    expect(s.segments[0]).toMatchObject({ bCoef: 1, cGroup: CollisionFlags.wall, cMask: CollisionFlags.all, bias: 0, vis: true, color: 0, curveF: Infinity, arc: null });
    expect(s.planes[0]).toEqual({ normal: { x: 0, y: 1 }, dist: -10, bCoef: 1, cGroup: CollisionFlags.wall, cMask: CollisionFlags.all });
  });

  test('top-level, bg and playerPhysics overrides', () => {
    const s = parse({
      maxViewWidth: 800.7,
      cameraFollow: 'player',
      spawnDistance: 120,
      canBeStored: false,
      kickOffReset: 'full',
      bg: { type: 'hockey', width: 250, height: 150, kickOffRadius: 60, cornerRadius: 30, goalLine: 200, color: [10, 20, 30] },
      playerPhysics: { radius: 12, kickStrength: 6, kickback: 1, cGroup: ['c0'], gravity: [0, 0.05] },
      redSpawnPoints: [[-100, 0], [-100, 40]],
      blueSpawnPoints: [[100, 0]],
    });
    expect(s).toMatchObject({ maxViewWidth: 800, cameraFollow: 'player', spawnDistance: 120, canBeStored: false, kickOffReset: 'full' });
    expect(s.bg).toEqual({ type: 'hockey', width: 250, height: 150, kickOffRadius: 60, cornerRadius: 30, goalLine: 200, color: 0x0a141e });
    expect(s.playerPhysics).toMatchObject({ radius: 12, kickStrength: 6, kickback: 1, cGroup: CollisionFlags.c0, gravity: { x: 0, y: 0.05 }, damping: 0.96 });
    expect(s.redSpawnPoints).toEqual([{ x: -100, y: 0 }, { x: -100, y: 40 }]);
    expect(s.blueSpawnPoints).toEqual([{ x: 100, y: 0 }]);
  });

  test('plane normals are normalised', () => {
    const s = parse({ planes: [{ normal: [3, -4], dist: 5 }] });
    expect(s.planes[0].normal).toEqual({ x: 0.6, y: -0.8 });
    expect(s.planes[0].dist).toBe(5);
  });

  test('goals map team names to team ids', () => {
    const s = parse({ goals: [{ p0: [-1, -2], p1: [-1, 2], team: 'red' }, { p0: [1, -2], p1: [1, 2], team: 'blue' }] });
    expect(s.goals).toEqual([
      { p0: { x: -1, y: -2 }, p1: { x: -1, y: 2 }, team: 1 },
      { p0: { x: 1, y: -2 }, p1: { x: 1, y: 2 }, team: 2 },
    ]);
  });
});

describe('ballPhysics', () => {
  test('an object replaces the ball and still gets kick|score', () => {
    const s = parse({ ballPhysics: { radius: 6, invMass: 1.5, color: 'EAFF00', cGroup: ['ball', 'c1'] } });
    expect(s.discs[0]).toMatchObject({
      radius: 6,
      invMass: 1.5,
      damping: 0.99,
      color: 0xeaff00,
      cGroup: CollisionFlags.ball | CollisionFlags.c1 | CollisionFlags.kick | CollisionFlags.score,
    });
  });

  test('"disc0" uses the first disc unchanged', () => {
    const s = parse({ ballPhysics: 'disc0', discs: [{ pos: [1, 2], cGroup: ['ball'] }, { pos: [3, 4] }] });
    expect(s.discs).toHaveLength(2);
    expect(s.discs[0]).toMatchObject({ pos: { x: 1, y: 2 }, cGroup: CollisionFlags.ball });
  });

  test('"disc0" without discs is an error', () => {
    expect(errorOf({ ballPhysics: 'disc0' }).path).toBe('ballPhysics');
  });

  test('["disc0"] counts as "disc0" and any other non-object as the default ball, with no trait applied', () => {
    expect(parse({ ballPhysics: ['disc0'], discs: [{ radius: 3 }] }).discs).toEqual([expect.objectContaining({ radius: 3 })]);
    expect(parse({ ballPhysics: 'big' }).discs[0].radius).toBe(10);
    expect(parse({ traits: { t: { radius: 4 } }, ballPhysics: { trait: 't' } }).discs[0].radius).toBe(10);
  });

  test('the ball counts toward the 255 discs', () => {
    expect(errorOf({ discs: Array.from({ length: 255 }, () => ({})) }).message).toBe('discs: has 256 discs counting the ball, the limit is 255');
    expect(parse({ ballPhysics: 'disc0', discs: Array.from({ length: 255 }, () => ({})) }).discs).toHaveLength(255);
  });

  test('every disc gets its own vector objects', () => {
    const s = parse({ discs: [{}, {}] });
    expect(s.discs[1].pos).not.toBe(s.discs[2].pos);
    expect(s.discs[0].speed).not.toBe(s.discs[1].speed);
  });
});

describe('traits', () => {
  test('objects inherit missing fields and override present ones', () => {
    const s = parse({
      traits: {
        post: { radius: 8, invMass: 0, bCoef: 0.5, color: 'FFCCCC' },
        area: { vis: false, bCoef: 1, cMask: ['ball'], curve: 90 },
      },
      vertexes: square,
      segments: [{ v0: 0, v1: 1, trait: 'area' }, { v0: 0, v1: 1, trait: 'area', vis: true, curve: 0 }],
      discs: [{ pos: [0, 0], trait: 'post', color: 'CCCCFF' }],
    });
    expect(s.discs[1]).toMatchObject({ radius: 8, invMass: 0, bCoef: 0.5, color: 0xccccff });
    expect(s.segments[0]).toMatchObject({ vis: false, bCoef: 1, cMask: CollisionFlags.ball });
    expect(s.segments[0].arc).not.toBeNull();
    expect(s.segments[1]).toMatchObject({ vis: true, cMask: CollisionFlags.ball, arc: null });
  });

  test('null fields take the trait value, and an unknown trait or a list of traits loads like the original', () => {
    const s = parse({ traits: { post: { radius: 8 } }, discs: [{ trait: 'post', radius: null }, { trait: 'nope' }] });
    expect(s.discs[1].radius).toBe(8);
    expect(s.discs[2].radius).toBe(10);
    expect(parse({ traits: [{ radius: 4 }], discs: [{ trait: 0 }] }).discs[1].radius).toBe(4);
    expect(parse({ traits: [], discs: [{}] }).discs).toHaveLength(2);
  });
});

describe('collision flags', () => {
  const maskOf = (cMask: unknown) => parse({ planes: [{ normal: [1, 0], dist: 0, cMask }] }).planes[0].cMask;

  test('names combine into the Headless API bitmask', () => {
    expect(maskOf(['red', 'blue', 'redKO', 'ball', 'c1'])).toBe(2 | 4 | 8 | 1 | (1 << 29));
    expect(maskOf(['all', 'c0', 'c2'])).toBe(63 | (1 << 28) | (1 << 30));
    expect(maskOf(['kick', 'score'])).toBe(192);
    expect(maskOf(['c3'])).toBe(1 << 31);
    expect(maskOf([])).toBe(0);
  });

  test('a single name may be a plain string', () => {
    expect(maskOf('wall')).toBe(32);
  });

  test('unknown names add nothing, as published maps rely on it', () => {
    expect(maskOf(['', 'none', 'c4', 'ball'])).toBe(1);
  });

  test('non-string entries add nothing, but a mask that is not a list is an error', () => {
    expect(maskOf(['ball', 5, null])).toBe(1);
    expect(errorOf({ planes: [{ normal: [1, 0], dist: 0, cMask: 3 }] }).path).toBe('planes[0].cMask');
  });
});

describe('colors', () => {
  const colorOf = (color: unknown) => parse({ discs: [{ color }] }).discs[1].color;

  test('hex, rgb array and transparent', () => {
    expect(colorOf('FF0000')).toBe(0xff0000);
    expect(colorOf('3a7d44')).toBe(0x3a7d44);
    expect(colorOf([0, 200, 0])).toBe(0x00c800);
    expect(colorOf('transparent')).toBe(-1);
  });

  test('hex of any length keeps the low RGB bytes and unreadable text is black, as parseInt("0x" + text) gives', () => {
    expect(colorOf('ffffffff')).toBe(0xffffff);
    expect(colorOf('FFFFFFFFF')).toBe(0xffffff);
    expect(colorOf('12345G')).toBe(0x12345);
    expect(colorOf('red')).toBe(0);
    expect(colorOf('#FF0000')).toBe(0);
  });

  test('rgb arrays are summed like the original, without range checks', () => {
    expect(colorOf(['255', 0, 0])).toBe(0xff0000);
    expect(colorOf([0, 256, 0])).toBe(0x010000);
  });

  test('a color that is neither text nor a list reports its path', () => {
    expect(errorOf({ discs: [{ color: 16777215 }] }).path).toBe('discs[0].color');
  });
});

describe('segment curves', () => {
  const segmentOf = (seg: object, vertexes: object[] = square) => parse({ vertexes, segments: [{ v0: 0, v1: 1, ...seg }] }).segments[0];

  test('straight segment normal', () => {
    const s = segmentOf({});
    expect(s.normal).toEqual({ x: -0, y: -1 });
    expect(s.curveF).toBe(Infinity);
  });

  test('+90° arc between (-100,0) and (100,0)', () => {
    const s = segmentOf({ curve: 90 });
    expect(s.v0).toBe(0);
    expect(s.curveF).toBeCloseTo(1, 14);
    expect(s.arc!.center.x).toBeCloseTo(0, 12);
    expect(s.arc!.center.y).toBeCloseTo(100, 12);
    expect(s.arc!.radius).toBeCloseTo(100 * Math.SQRT2, 12);
    expect(s.normal).toBeNull();
  });

  test('negative curve swaps the vertices and negates bias', () => {
    const s = segmentOf({ curve: -90, bias: 3 });
    expect([s.v0, s.v1]).toEqual([1, 0]);
    expect(s.bias).toBe(-3);
    expect(s.arc!.center.y).toBeCloseTo(-100, 12);
    expect(s.arc!.radius).toBeCloseTo(100 * Math.SQRT2, 12);
  });

  test('180° gives a half circle around the chord midpoint', () => {
    const s = segmentOf({ curve: 180 }, [{ x: 0, y: -75 }, { x: 0, y: 75 }]);
    expect(s.curveF).toBeGreaterThan(0);
    expect(s.arc!.center.x).toBeCloseTo(0, 12);
    expect(s.arc!.center.y).toBeCloseTo(0, 12);
    expect(s.arc!.radius).toBeCloseTo(75, 12);
  });

  test('small curve matches the closed form', () => {
    const s = segmentOf({ curve: 20 });
    const half = (20 * Math.PI) / 180 / 2;
    expect(s.curveF).toBeCloseTo(1 / Math.tan(half), 10);
    expect(s.arc!.center.y).toBeCloseTo(100 / Math.tan(half), 9);
    expect(s.arc!.radius).toBeCloseTo(100 / Math.sin(half), 9);
  });

  test('curves at or below ~10° and at or above 340° are straight', () => {
    for (const curve of [5, -5, 9.99, 340, 350, -345]) {
      const s = segmentOf({ curve });
      expect(s.arc).toBeNull();
      expect(s.curveF).toBe(Infinity);
    }
    expect(segmentOf({ curve: 10 }).arc).not.toBeNull();
    expect(segmentOf({ curve: 339 }).arc).not.toBeNull();
  });

  test('tangent limits; negated when curveF is not positive', () => {
    const s = segmentOf({ curve: 90 });
    expect(s.arc!.tan0.x).toBeCloseTo(100, 12);
    expect(s.arc!.tan0.y).toBeCloseTo(-100, 12);
    expect(s.arc!.tan1.x).toBeCloseTo(-100, 12);
    expect(s.arc!.tan1.y).toBeCloseTo(-100, 12);
    const r = segmentOf({ curveF: -1 });
    expect(r.arc!.center.y).toBeCloseTo(-100, 12);
    expect(r.arc!.tan0.x).toBeCloseTo(100, 12);
    expect(r.arc!.tan0.y).toBeCloseTo(100, 12);
  });

  test('curveF takes precedence over curve', () => {
    const s = segmentOf({ curve: -90, curveF: 2 });
    expect([s.v0, s.v1]).toEqual([0, 1]);
    expect(s.curveF).toBe(2);
    expect(s.arc!.center.y).toBeCloseTo(200, 12);
  });
});

describe('joints', () => {
  const discs = [{ pos: [0, 0] }, { pos: [30, 40] }];
  const jointOf = (joint: object) => parse({ discs, joints: [{ d0: 1, d1: 2, ...joint }] }).joints[0];

  test('null or missing length is the initial distance; indices count the ball', () => {
    expect(jointOf({ length: null })).toEqual({ d0: 1, d1: 2, minLength: 50, maxLength: 50, strength: Infinity, color: 0, breakLength: Infinity });
    expect(jointOf({})).toMatchObject({ minLength: 50, maxLength: 50 });
  });

  test('numeric and ranged length', () => {
    expect(jointOf({ length: 20 })).toMatchObject({ minLength: 20, maxLength: 20 });
    expect(jointOf({ length: [10, 60] })).toMatchObject({ minLength: 10, maxLength: 60 });
  });

  test('strength and color', () => {
    expect(jointOf({ strength: 'rigid' }).strength).toBe(Infinity);
    expect(jointOf({ strength: 0.25, color: 'transparent' })).toMatchObject({ strength: 0.25, color: -1 });
  });

  test('out-of-range disc index reports its path', () => {
    expect(errorOf({ discs, joints: [{ d0: 0, d1: 3 }] }).path).toBe('joints[0].d1');
  });

  test('breakLength is read as given and never breaks when left out', () => {
    expect(jointOf({ breakLength: 120 }).breakLength).toBe(120);
    expect(errorOf({ discs, joints: [{ d0: 0, d1: 1, breakLength: 'far' }] }).path).toBe('joints[0].breakLength');
  });

  test('bad length reports its path', () => {
    expect(errorOf({ discs, joints: [{ d0: 0, d1: 1, length: 'x' }] }).path).toBe('joints[0].length');
  });
});

describe('errors', () => {
  test('JSON5 syntax errors carry line and column', () => {
    const e = parseError('{\n  name: "x",\n  width: 10,\n  height: ]\n}');
    expect(e.line).toBe(4);
    expect(e.column).toBe(11);
    expect(e.path).toBeNull();
  });

  test('semantic errors carry the object path and no position', () => {
    const e = errorOf({ vertexes: square, segments: [{ v0: 0, v1: 1 }, { v0: 0, v1: 2 }] });
    expect(e.path).toBe('segments[1].v1');
    expect(e.line).toBeNull();
    expect(e.message).toContain('segments[1].v1');
  });

  test('each object list holds at most 4096 objects and an overflow names the list', () => {
    const vertexes = Array.from({ length: 4096 }, (_, i) => ({ x: i, y: 0 }));
    expect(parse({ vertexes }).vertexes).toHaveLength(4096);
    for (const key of ['vertexes', 'segments', 'goals', 'planes', 'joints']) {
      const e = errorOf({ [key]: Array.from({ length: 4097 }, () => ({})) });
      expect(e.path).toBe(key);
      expect(e.message).toBe(`${key}: has 4097 objects, the limit is 4096`);
    }
  });

  test('wrong types fail the map like the original casts do', () => {
    expect(errorOf({ goals: [{ p0: [0, 0], p1: [0, 1], team: 'green' }] }).path).toBe('goals[0].team');
    expect(errorOf({ vertexes: [{ x: 1, y: '2' }] }).path).toBe('vertexes[0].y');
    expect(errorOf({ discs: [{ pos: { x: 1, y: 2 } }] }).path).toBe('discs[0].pos');
    expect(errorOf({ segments: {} }).path).toBe('segments');
    expect(errorOf({ name: 5 }).path).toBe('name');
    expect(parseError('{ width: 1, height: 1 }').path).toBe('name');
    expect(errorOf({ vertexes: [{ x: 1 }] }).path).toBe('vertexes[0].y');
    expect(errorOf({ vertexes: [{ x: 1, y: null }] }).path).toBe('vertexes[0].y');
    expect(errorOf({ playerPhysics: { gravity: [0] } }).path).toBe('playerPhysics.gravity[1]');
    expect(errorOf({ canBeStored: 'no' }).path).toBe('canBeStored');
    expect(parseError('[]').path).toBeNull();
  });

  test('loads what the original loads: null as missing, unknown choices as defaults, Infinity, and uncast disc and goal points', () => {
    expect(parse({ bg: { type: 'sand' }, cameraFollow: 'none', kickOffReset: 'all' })).toMatchObject({ bg: { type: 'none' }, cameraFollow: 'ball', kickOffReset: 'partial' });
    expect(parse({ bg: { type: '' } }).bg.type).toBe('none');
    expect(parse({ spawnDistance: null, maxViewWidth: null, bg: null, playerPhysics: null, vertexes: null })).toMatchObject({ spawnDistance: 200, maxViewWidth: 0, vertexes: [] });
    expect(parse({ vertexes: square, segments: [{ v0: 0, v1: 1, bias: null, curve: null, curveF: null, color: null, cMask: null }] }).segments[0]).toMatchObject({ bias: 0, curveF: Infinity, color: 0, cMask: CollisionFlags.all });
    expect(parseStadium('{ name: "x", width: 1, height: 1, discs: [{ invMass: Infinity }] }').discs[1].invMass).toBe(Infinity);
    expect(parse({ discs: [{ pos: [1, null] }, { pos: [1] }] }).discs.slice(1).map((d) => d.pos)).toEqual([{ x: 1, y: 0 }, { x: 1, y: NaN }]);
    expect(parse({ goals: [{ p0: [0], p1: [0, 1], team: 'red' }] }).goals[0].p0).toEqual({ x: 0, y: NaN });
    expect(Number.isNaN(parse({ planes: [{ normal: [0, 0], dist: 0 }] }).planes[0].normal.x)).toBe(true);
  });
});

test('a zero-length straight segment loads instead of failing the whole map', () => {
  const s = parse({ vertexes: [{ x: 5, y: 5 }, { x: 5, y: 5 }], segments: [{ v0: 0, v1: 1 }] });
  expect(s.segments[0].normal).toEqual({ x: 0, y: 0 });
});
