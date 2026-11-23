import JSON5 from 'json5';

interface PitchSpec {
  name: string;
  halfLength: number;
  halfWidth: number;
  goalHalfWidth: number;
  cornerRadius: number;
  kickOffRadius: number;
  spawnDistance: number;
  boundsX: number;
  boundsY: number;
  /** Rink layout: goals stand inside the boards at this x, and nets also stop players. */
  rinkGoalLine?: number;
}

const NET_CURVE = 130;

function pitch(spec: PitchSpec): Record<string, unknown> {
  const { halfLength: w, halfWidth: h, goalHalfWidth: g, cornerRadius: r, kickOffRadius: k } = spec;
  const rink = spec.rinkGoalLine !== undefined;
  const goalX = spec.rinkGoalLine ?? w;
  const vertexes: object[] = [];
  const segments: object[] = [];
  const vertex = (x: number, y: number, trait: string): number => vertexes.push({ x, y, trait }) - 1;
  const segment = (v0: number, v1: number, trait: string, extra: object = {}): void => {
    segments.push({ v0, v1, trait, ...extra });
  };

  const goals: object[] = [];
  const discs: object[] = [];
  const touchlineEnds: Record<number, number[]> = { [-1]: [], [1]: [] };
  for (const sx of [-1, 1]) {
    const top = vertex(sx * goalX, -g, 'goalNet');
    const bottom = vertex(sx * goalX, g, 'goalNet');
    segment(top, bottom, 'goalNet', { curve: sx * NET_CURVE });
    goals.push({ p0: [sx * goalX, -g], p1: [sx * goalX, g], team: sx < 0 ? 'red' : 'blue' });
    for (const y of [-g, g]) discs.push({ pos: [sx * goalX, y], trait: 'goalPost', color: sx < 0 ? 'F4C2B8' : 'B8CAF4' });

    const boardEnds = [-1, 1].map((sy) => {
      const end = vertex(sx * w, sy * (h - r), 'ballArea');
      if (r > 0) {
        const touch = vertex(sx * (w - r), sy * h, 'ballArea');
        segment(end, touch, 'ballArea', { curve: 90 * sx * sy });
        touchlineEnds[sy].push(touch);
      } else {
        touchlineEnds[sy].push(end);
      }
      if (!rink) segment(sy < 0 ? top : bottom, end, 'ballArea');
      return end;
    });
    if (rink) segment(boardEnds[0], boardEnds[1], 'ballArea');
  }
  for (const sy of [-1, 1]) segment(touchlineEnds[sy][0], touchlineEnds[sy][1], 'ballArea');

  const lineTop = vertex(0, -spec.boundsY, 'kickOffBarrier');
  const circleTop = vertex(0, -k, 'kickOffBarrier');
  const circleBottom = vertex(0, k, 'kickOffBarrier');
  const lineBottom = vertex(0, spec.boundsY, 'kickOffBarrier');
  segment(lineTop, circleTop, 'kickOffBarrier');
  segment(circleBottom, lineBottom, 'kickOffBarrier');
  segment(circleTop, circleBottom, 'kickOffBarrier', { curve: 180, cGroup: ['redKO'] });
  segment(circleTop, circleBottom, 'kickOffBarrier', { curve: -180, cGroup: ['blueKO'] });

  return {
    name: spec.name,
    width: spec.boundsX,
    height: spec.boundsY,
    spawnDistance: spec.spawnDistance,
    bg: {
      type: rink ? 'hockey' : 'grass',
      width: w,
      height: h,
      kickOffRadius: k,
      cornerRadius: r,
      ...(rink ? { goalLine: goalX } : {}),
    },
    traits: {
      ballArea: { vis: false, bCoef: 1, cMask: ['ball'] },
      goalPost: { radius: 8, invMass: 0, bCoef: 0.5 },
      goalNet: { vis: true, bCoef: 0.1, cMask: rink ? ['all'] : ['ball'], color: 'E8E8E8' },
      kickOffBarrier: { vis: false, bCoef: 0.1, cGroup: ['redKO', 'blueKO'], cMask: ['red', 'blue'] },
      playerBounds: { bCoef: 0.1 },
    },
    vertexes,
    segments,
    goals,
    discs,
    planes: [
      { normal: [0, 1], dist: -spec.boundsY, trait: 'playerBounds' },
      { normal: [0, -1], dist: -spec.boundsY, trait: 'playerBounds' },
      { normal: [1, 0], dist: -spec.boundsX, trait: 'playerBounds' },
      { normal: [-1, 0], dist: -spec.boundsX, trait: 'playerBounds' },
    ],
  };
}

function toSource(stadium: Record<string, unknown>): string {
  const lines = Object.entries(stadium).map(([key, value]) => {
    if (Array.isArray(value)) return `  ${key}: [\n${value.map((v) => `    ${JSON5.stringify(v)},`).join('\n')}\n  ],`;
    if (key === 'traits') {
      const entries = Object.entries(value as object).map(([name, t]) => `    ${name}: ${JSON5.stringify(t)},`);
      return `  traits: {\n${entries.join('\n')}\n  },`;
    }
    return `  ${key}: ${JSON5.stringify(value)},`;
  });
  return `{\n${lines.join('\n')}\n}\n`;
}

const standard: PitchSpec = {
  name: 'Standard',
  halfLength: 390,
  halfWidth: 180,
  goalHalfWidth: 62,
  cornerRadius: 0,
  kickOffRadius: 80,
  spawnDistance: 180,
  boundsX: 450,
  boundsY: 215,
};
const stadium: PitchSpec = {
  name: 'Stadium',
  halfLength: 560,
  halfWidth: 250,
  goalHalfWidth: 76,
  cornerRadius: 0,
  kickOffRadius: 88,
  spawnDistance: 300,
  boundsX: 625,
  boundsY: 290,
};

const specs: PitchSpec[] = [
  standard,
  { ...standard, name: 'Wide Goals', goalHalfWidth: 86, boundsX: 470 },
  {
    name: 'Compact',
    halfLength: 300,
    halfWidth: 140,
    goalHalfWidth: 52,
    cornerRadius: 0,
    kickOffRadius: 66,
    spawnDistance: 140,
    boundsX: 352,
    boundsY: 172,
  },
  stadium,
  { ...standard, name: 'Oval', cornerRadius: 70 },
  {
    name: 'Rink',
    halfLength: 410,
    halfWidth: 190,
    goalHalfWidth: 58,
    cornerRadius: 90,
    kickOffRadius: 72,
    spawnDistance: 190,
    boundsX: 410,
    boundsY: 190,
    rinkGoalLine: 300,
  },
  {
    name: 'Big Rink',
    halfLength: 580,
    halfWidth: 260,
    goalHalfWidth: 80,
    cornerRadius: 130,
    kickOffRadius: 86,
    spawnDistance: 290,
    boundsX: 580,
    boundsY: 260,
    rinkGoalLine: 430,
  },
  { ...stadium, name: 'Stadium Wide Goals', goalHalfWidth: 100, boundsX: 640 },
  { ...stadium, name: 'Big Oval', cornerRadius: 100 },
  {
    name: 'Colossal',
    halfLength: 760,
    halfWidth: 340,
    goalHalfWidth: 96,
    cornerRadius: 0,
    kickOffRadius: 96,
    spawnDistance: 380,
    boundsX: 830,
    boundsY: 385,
  },
];

/** Built-in stadiums; the first one is the room default. */
export const defaultStadiums: readonly { name: string; source: string }[] = specs.map((spec) => ({
  name: spec.name,
  source: toSource(pitch(spec)),
}));
