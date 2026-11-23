import { CollisionFlags, Team, type Disc, type GameState, type RoomState, type SimPlayer, type Stadium, type Vec2 } from '@golix/shared';
import type { ViewSettings } from '../../src/render/types.ts';

export function disc(pos: Vec2, radius: number, color: number, invMass = 1): Disc {
  return {
    pos,
    speed: { x: 0, y: 0 },
    gravity: { x: 0, y: 0 },
    radius,
    invMass,
    damping: 0.99,
    bCoef: 0.5,
    color,
    cGroup: CollisionFlags.ball,
    cMask: CollisionFlags.all,
  };
}

const vertex = (x: number, y: number) => ({ pos: { x, y }, bCoef: 1, cGroup: CollisionFlags.wall, cMask: CollisionFlags.all });

export function makeStadium(): Stadium {
  const base = { bCoef: 1, cGroup: CollisionFlags.wall, cMask: CollisionFlags.ball, bias: 0 };
  return {
    name: 'Fixture',
    width: 420,
    height: 200,
    maxViewWidth: 0,
    cameraFollow: 'ball',
    spawnDistance: 170,
    canBeStored: true,
    kickOffReset: 'partial',
    bg: { type: 'grass', width: 370, height: 170, kickOffRadius: 75, cornerRadius: 0, goalLine: 0, color: 0x3f7f5f },
    vertexes: [vertex(-370, 170), vertex(370, 170), vertex(-370, -64), vertex(-400, -34), vertex(0, -200), vertex(0, 200)],
    segments: [
      { ...base, v0: 0, v1: 1, vis: true, color: 0xf0f0f0, curveF: Infinity, normal: { x: 0, y: -1 }, arc: null },
      {
        ...base,
        v0: 2,
        v1: 3,
        vis: true,
        color: 0x202020,
        curveF: 1,
        normal: null,
        arc: { center: { x: -370, y: -34 }, radius: 30, tan0: { x: -1, y: 0 }, tan1: { x: 0, y: -1 } },
      },
      { ...base, v0: 4, v1: 5, vis: false, color: 0xffffff, curveF: Infinity, normal: { x: 1, y: 0 }, arc: null },
    ],
    goals: [
      { p0: { x: -370, y: 64 }, p1: { x: -370, y: -64 }, team: Team.red },
      { p0: { x: 370, y: 64 }, p1: { x: 370, y: -64 }, team: Team.blue },
    ],
    discs: [],
    planes: [],
    joints: [{ d0: 1, d1: 2, minLength: 128, maxLength: 128, strength: Infinity, color: 0x806040, breakLength: Infinity }],
    redSpawnPoints: [],
    blueSpawnPoints: [],
    playerPhysics: {
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
    },
  };
}

export function player(id: number, team: Team, pos: Vec2 | null, extra: Partial<SimPlayer> = {}): SimPlayer {
  return {
    id,
    team,
    input: 0,
    kicking: false,
    kickCooldown: 0,
    kickTokens: 0,
    disc: pos ? disc(pos, 15, -1, 0.5) : null,
    ...extra,
  };
}

export function makeGame(overrides: Partial<GameState> = {}): GameState {
  const stadium = makeStadium();
  return {
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
    scoreLimit: 3,
    timeLimit: 3,
    stadium,
    discs: [disc({ x: 0, y: 0 }, 10, 0xffffff), disc({ x: -370, y: 64 }, 8, 0xffcccc, 0), disc({ x: -370, y: -64 }, 8, 0xffcccc, 0), disc({ x: 0, y: 300 }, 5, -1)],
    players: [player(1, Team.red, { x: -170, y: 0 }), player(2, Team.blue, { x: 170, y: 0 }), player(3, Team.spectators, null)],
    joints: stadium.joints.map(({ d0, d1, ...rest }) => ({ ...rest, a: { disc: d0 }, b: { disc: d1 } })),
    ...overrides,
  };
}

export function makeRoom(game: GameState): RoomState {
  const rp = (id: number, name: string, team: Team, avatar = '') => ({ id, name, team, admin: id === 1, avatar, country: 'tr', joinSeq: id, ping: 0 });
  return {
    name: 'Fixture room',
    maxPlayers: 12,
    hasPassword: false,
    players: [rp(1, 'Ada', Team.red), rp(2, 'Bora', Team.blue, 'GK'), rp(3, 'Cem', Team.spectators)],
    teamsLock: false,
    scoreLimit: 3,
    timeLimit: 3,
    redColors: { angle: 45, textColor: 0xffffff, colors: [0xcc2200, 0xffaa00] },
    blueColors: { angle: 0, textColor: 0x000000, colors: [0x0055cc] },
    redName: '',
    blueName: '',
    stadiumSource: '',
    kickRateLimit: { min: 2, rate: 0, burst: 0 },
    actionKeys: false,
    hud: [],
    camera: { follow: null, zoom: 1 },
    game,
  };
}

export const defaultView: ViewSettings = {
  viewMode: 1,
  resolutionScale: 1,
  showNames: true,
  showAvatars: true,
  customTeamColors: true,
  showTypingIndicators: true,
  clampCamera: true,
  bottomInset: 0,
};
