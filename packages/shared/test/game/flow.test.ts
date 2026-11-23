import { describe, expect, it } from 'vitest';
import { applyEvent, cloneRoom, getStadium, hashRoom } from '../../src/game/index.ts';
import { decodeServerMessage, encodeServerMessage } from '../../src/protocol/index.ts';
import { CollisionFlags, InputFlags, Team } from '../../src/types.ts';
import { customStadium, game, join, newRoom, props, score, setBall, step, stepUntil } from './helpers.ts';

const BASE_MASK = CollisionFlags.ball | CollisionFlags.red | CollisionFlags.blue | CollisionFlags.wall;

function started(setup: (room: ReturnType<typeof newRoom>) => void = () => {}) {
  const room = newRoom();
  join(room, 1, Team.red);
  join(room, 2, Team.blue);
  setup(room);
  applyEvent(room, { type: 'startGame', byPlayer: null });
  return room;
}

function disc(room: ReturnType<typeof newRoom>, id: number) {
  const d = game(room).players.find((p) => p.id === id)?.disc;
  if (!d) throw new Error(`player ${id} has no disc`);
  return d;
}

describe('kickoff', () => {
  it('applies the kicking-off team KO flag to every player and lifts it when the ball moves', () => {
    const room = started();
    expect(game(room).phase).toBe('kickoff');
    step(room, 10);
    expect(disc(room, 1).cMask).toBe(BASE_MASK | CollisionFlags.redKO);
    expect(disc(room, 2).cMask).toBe(BASE_MASK | CollisionFlags.redKO);
    expect(game(room).time).toBe(0);

    setBall(room, { xspeed: 1 });
    expect(step(room)).toContainEqual({ type: 'kickoff' });
    expect(game(room).phase).toBe('playing');
    expect(game(room).time).toBe(0);
    step(room);
    expect(game(room).time).toBe(1 / 60);
    expect(disc(room, 1).cMask).toBe(BASE_MASK);
  });

  it('creates reset discs with the plain mask and adds the KO flag on the first kickoff step, as the original does', () => {
    const room = started();
    expect(disc(room, 1).cMask).toBe(BASE_MASK);
    step(room, 1);
    expect(disc(room, 1).cMask).toBe(BASE_MASK | CollisionFlags.redKO);
    expect(disc(room, 2).cMask).toBe(BASE_MASK | CollisionFlags.redKO);
    score(room, Team.red);
    stepUntil(room, 'positionsReset');
    expect(disc(room, 1).cMask).toBe(BASE_MASK);
    step(room, 1);
    expect(disc(room, 1).cMask).toBe(BASE_MASK | CollisionFlags.redKO);
    score(room, Team.blue);
    stepUntil(room, 'positionsReset');
    step(room, 1);
    expect(disc(room, 2).cMask).toBe(BASE_MASK | CollisionFlags.blueKO);
  });

  it('keeps a key held through a reset, so the player moves on the first kickoff tick', () => {
    const room = started();
    applyEvent(room, { type: 'input', playerId: 1, input: InputFlags.right });
    score(room, Team.red);
    stepUntil(room, 'positionsReset');
    const x = disc(room, 1).pos.x;
    step(room);
    expect(game(room).players.find((p) => p.id === 1)!.input).toBe(InputFlags.right);
    expect(disc(room, 1).pos.x).toBeGreaterThan(x);
  });

  it('keeps the non-kicking team out of the centre circle', () => {
    const room = started();
    const kickOffRadius = game(room).stadium.bg.kickOffRadius;
    applyEvent(room, { type: 'setPlayerDiscProperties', playerId: 2, props: props({ x: kickOffRadius + 40, y: 0 }) });
    applyEvent(room, { type: 'input', playerId: 2, input: InputFlags.left });
    step(room, 120);
    expect(game(room).phase).toBe('kickoff');
    expect(disc(room, 2).pos.x).toBeGreaterThan(kickOffRadius);
  });
});

describe('goals', () => {
  it('runs a 150-tick goal phase, resets, and lets the conceding team kick off', () => {
    const room = started();
    expect(score(room, Team.blue)).toEqual({ type: 'goal', team: Team.red });
    expect(game(room)).toMatchObject({ phase: 'goal', red: 1, blue: 0, scoringTeam: Team.red, kickoffTeam: Team.blue });
    const clock = game(room).time;

    const { ticks } = stepUntil(room, 'positionsReset');
    expect(ticks).toBe(150);
    expect(game(room).time).toBe(clock);
    expect(game(room).phase).toBe('kickoff');
    expect(game(room).discs[0].pos).toEqual({ x: 0, y: 0 });
    expect(disc(room, 1).pos.x).toBe(-game(room).stadium.spawnDistance);
    step(room);
    expect(disc(room, 1).cMask).toBe(BASE_MASK | CollisionFlags.blueKO);
  });

  it('ends the game at the score limit, then stops it after 300 ticks', () => {
    const room = started((r) => applyEvent(r, { type: 'setScoreLimit', value: 2, byPlayer: null }));
    score(room, Team.red);
    stepUntil(room, 'positionsReset');
    score(room, Team.red);
    const victory = stepUntil(room, 'victory');
    expect(victory).toEqual({ ticks: 150, outcome: { type: 'victory', team: Team.blue } });
    expect(game(room)).toMatchObject({ phase: 'ended', winner: Team.blue, blue: 2 });
    expect(stepUntil(room, 'gameStop').ticks).toBe(300);
    expect(room.game).toBeNull();
  });

  it('ends at the time limit when a team leads', () => {
    const room = started((r) => applyEvent(r, { type: 'setTimeLimit', value: 1, byPlayer: null }));
    score(room, Team.blue);
    stepUntil(room, 'positionsReset');
    setBall(room, { xspeed: 0.1 });
    stepUntil(room, 'victory');
    expect(game(room)).toMatchObject({ winner: Team.red, overtime: false });
    // Float accumulation of 1/60 reaches 60 only on the 3601st playing tick, as measured in the original.
    expect(Math.round(game(room).time * 60)).toBe(3601);
  });

  it('goes to overtime on a draw and ends on the golden goal', () => {
    const room = started((r) => applyEvent(r, { type: 'setTimeLimit', value: 1, byPlayer: null }));
    setBall(room, { xspeed: 0.1 });
    step(room, 3601);
    expect(game(room)).toMatchObject({ phase: 'playing', overtime: false });
    step(room, 1);
    expect(game(room)).toMatchObject({ phase: 'playing', overtime: true });
    expect(Math.round(game(room).time * 60)).toBe(3601);
    step(room, 100);
    expect(Math.round(game(room).time * 60)).toBe(3701);

    score(room, Team.red);
    expect(stepUntil(room, 'victory')).toEqual({ ticks: 150, outcome: { type: 'victory', team: Team.blue } });
    expect(stepUntil(room, 'gameStop').ticks).toBe(300);
    expect(room.game).toBeNull();
  });
});

describe('pause', () => {
  it('freezes physics while paused and for 119 ticks after resuming', () => {
    const room = started();
    setBall(room, { xspeed: 2 });
    step(room, 5);
    applyEvent(room, { type: 'setPaused', paused: true, byPlayer: null });
    const x = game(room).discs[0].pos.x;
    step(room, 500);
    expect(game(room).pauseCounter).toBe(120);
    expect(game(room).discs[0].pos.x).toBe(x);

    applyEvent(room, { type: 'setPaused', paused: false, byPlayer: null });
    step(room, 119);
    expect(game(room).pauseCounter).toBe(0);
    expect(game(room).discs[0].pos.x).toBe(x);
    step(room);
    expect(game(room).discs[0].pos.x).toBeGreaterThan(x);
  });
});

describe('kicking', () => {
  function besideBall(room: ReturnType<typeof newRoom>): void {
    setBall(room, { x: 0, y: 0, xspeed: 0, yspeed: 0 });
    applyEvent(room, { type: 'setPlayerDiscProperties', playerId: 1, props: props({ x: -26, y: 0, xspeed: 0, yspeed: 0 }) });
  }
  const kicks = (out: ReturnType<typeof step>) => out.filter((o) => o.type === 'kick').length;

  it('kicks once per press', () => {
    const room = started();
    besideBall(room);
    applyEvent(room, { type: 'input', playerId: 1, input: InputFlags.kick });
    expect(step(room)).toContainEqual({ type: 'kick', playerId: 1, discs: [0] });
    expect(game(room).discs[0].speed.x).toBeGreaterThan(4);
    expect(game(room).players[0].kicking).toBe(false);

    step(room, 5);
    besideBall(room);
    expect(kicks(step(room, 5))).toBe(0);

    applyEvent(room, { type: 'input', playerId: 1, input: 0 });
    applyEvent(room, { type: 'input', playerId: 1, input: InputFlags.kick });
    besideBall(room);
    expect(kicks(step(room))).toBe(1);
  });

  it('kicks as soon as the ball comes into reach while the key is held', () => {
    const room = started();
    applyEvent(room, { type: 'input', playerId: 1, input: InputFlags.kick });
    expect(kicks(step(room, 30))).toBe(0);
    expect(game(room).players[0].kicking).toBe(true);
    besideBall(room);
    expect(kicks(step(room))).toBe(1);
  });

  it('releasing the key drops the latch', () => {
    const room = started();
    applyEvent(room, { type: 'input', playerId: 1, input: InputFlags.kick });
    step(room);
    applyEvent(room, { type: 'input', playerId: 1, input: 0 });
    step(room);
    expect(game(room).players[0].kicking).toBe(false);
    besideBall(room);
    expect(kicks(step(room))).toBe(0);
  });

  it('applies the kick rate limit 2 15 3', () => {
    const room = started((r) => applyEvent(r, { type: 'setKickRateLimit', limit: { min: 2, rate: 15, burst: 3 }, byPlayer: null }));
    step(room, 60);
    const at: number[] = [];
    for (let t = 0; t < 50; t++) {
      besideBall(room);
      applyEvent(room, { type: 'input', playerId: 1, input: 0 });
      applyEvent(room, { type: 'input', playerId: 1, input: InputFlags.kick });
      if (kicks(step(room)) > 0) at.push(t);
    }
    // 45 tokens buy four kicks two ticks apart; tokens refill one per tick, so the fifth waits until they reach 0 again.
    expect(at).toEqual([0, 2, 4, 6, 15, 30, 45]);
  });
});

describe('spawning', () => {
  it('lines five red players up at 0, +55, -55, +110, -110', () => {
    const room = newRoom();
    for (let id = 1; id <= 5; id++) join(room, id, Team.red);
    applyEvent(room, { type: 'startGame', byPlayer: null });
    const x = -game(room).stadium.spawnDistance;
    expect(game(room).players.map((p) => p.disc?.pos)).toEqual([
      { x, y: -0 },
      { x, y: 55 },
      { x, y: -55 },
      { x, y: 110 },
      { x, y: -110 },
    ]);
  });

  it('follows room order, not id order', () => {
    const room = newRoom();
    for (let id = 1; id <= 3; id++) join(room, id, Team.blue);
    applyEvent(room, { type: 'reorderPlayers', playerIds: [3], moveToTop: true });
    applyEvent(room, { type: 'startGame', byPlayer: null });
    expect(disc(room, 3).pos.y).toBe(-0);
    expect(disc(room, 1).pos.y).toBe(55);
    expect(disc(room, 2).pos.y).toBe(-55);
  });

  it('moves a player who changes team to the end of the list, so they spawn last', () => {
    const room = newRoom();
    for (let id = 1; id <= 3; id++) join(room, id);
    applyEvent(room, { type: 'setTeam', playerId: 1, team: Team.red, byPlayer: null, announce: false });
    expect(room.players.map((p) => p.id)).toEqual([2, 3, 1]);
    applyEvent(room, { type: 'setTeam', playerId: 3, team: Team.red, byPlayer: null, announce: false });
    applyEvent(room, { type: 'startGame', byPlayer: null });
    expect(disc(room, 1).pos.y).toBe(-0);
    expect(disc(room, 3).pos.y).toBe(55);
  });

  it('simulates players in room order, following reorders and team changes mid-game', () => {
    const room = newRoom();
    for (let id = 1; id <= 3; id++) join(room, id, Team.red);
    applyEvent(room, { type: 'reorderPlayers', playerIds: [3], moveToTop: true });
    applyEvent(room, { type: 'startGame', byPlayer: null });
    expect(game(room).players.map((p) => p.id)).toEqual([3, 1, 2]);
    applyEvent(room, { type: 'reorderPlayers', playerIds: [1], moveToTop: false });
    expect(game(room).players.map((p) => p.id)).toEqual([3, 2, 1]);
    applyEvent(room, { type: 'setTeam', playerId: 3, team: Team.blue, byPlayer: null, announce: false });
    expect(game(room).players.map((p) => p.id)).toEqual([2, 1, 3]);
    join(room, 4);
    expect(game(room).players.map((p) => p.id)).toEqual(room.players.map((p) => p.id));
  });

  it('uses spawn point lists, stacking extra players on the last point', () => {
    const room = newRoom();
    applyEvent(room, {
      type: 'setStadium',
      source: customStadium((raw) => {
        raw.redSpawnPoints = [[-100, 10], [-100, 20]];
      }),
      byPlayer: null,
    });
    for (let id = 1; id <= 3; id++) join(room, id, Team.red);
    applyEvent(room, { type: 'startGame', byPlayer: null });
    expect(game(room).players.map((p) => p.disc?.pos)).toEqual([{ x: -100, y: 10 }, { x: -100, y: 20 }, { x: -100, y: 20 }]);
  });

  it('places mid-game joiners at the stadium edge on their side, as the original does, and removes discs of spectators', () => {
    const room = started();
    setBall(room, { xspeed: 1 });
    step(room, 10);
    join(room, 3, Team.blue);
    expect(disc(room, 3).pos).toEqual({ x: game(room).stadium.width, y: 0 });
    expect(disc(room, 3).cGroup & CollisionFlags.blue).toBe(CollisionFlags.blue);
    applyEvent(room, { type: 'setTeam', playerId: 3, team: Team.spectators, byPlayer: null, announce: false });
    expect(game(room).players.find((p) => p.id === 3)?.disc).toBeNull();
    applyEvent(room, { type: 'playerLeave', playerId: 1, kicked: false, ban: false, reason: '', byPlayer: null });
    expect(game(room).players.map((p) => p.id)).toEqual([2, 3]);
    expect(room.players.map((p) => p.id)).toEqual([2, 3]);
  });

  it('resets only the ball on partial and every stadium disc on full', () => {
    for (const reset of ['partial', 'full'] as const) {
      const room = newRoom();
      const source = customStadium((raw) => {
        raw.kickOffReset = reset;
        (raw.discs as unknown[]).push({ pos: [0, 150], radius: 5, invMass: 1 });
      });
      applyEvent(room, { type: 'setStadium', source, byPlayer: null });
      join(room, 1, Team.red);
      applyEvent(room, { type: 'startGame', byPlayer: null });
      const index = getStadium(source).discs.length - 1;
      applyEvent(room, { type: 'setDiscProperties', discIndex: index, props: props({ x: 50 }) });
      score(room, Team.blue);
      stepUntil(room, 'positionsReset');
      expect(game(room).discs[index].pos.x).toBe(reset === 'full' ? 0 : 50);
    }
  });

  it('gives players fresh discs on a reset, undoing script changes such as a smaller radius', () => {
    const room = newRoom();
    join(room, 1, Team.red);
    applyEvent(room, { type: 'startGame', byPlayer: null });
    applyEvent(room, { type: 'setPlayerDiscProperties', playerId: 1, props: props({ radius: 7, invMass: 2 }) });
    expect(game(room).players[0].disc).toMatchObject({ radius: 7, invMass: 2 });
    score(room, Team.blue);
    stepUntil(room, 'positionsReset');
    expect(game(room).players[0].disc).toMatchObject({ radius: 15, invMass: 0.5 });
  });
});

describe('room settings', () => {
  it('ignores limit and stadium changes while a game runs', () => {
    const room = started();
    const source = room.stadiumSource;
    applyEvent(room, { type: 'setScoreLimit', value: 7, byPlayer: null });
    applyEvent(room, { type: 'setTimeLimit', value: 7, byPlayer: null });
    applyEvent(room, { type: 'setStadium', source: 'x', byPlayer: null });
    expect(room).toMatchObject({ scoreLimit: 3, timeLimit: 3, stadiumSource: source });
    expect(applyEvent(room, { type: 'stopGame', byPlayer: null })).toEqual([{ type: 'gameStop' }]);
    expect(room.game).toBeNull();
    applyEvent(room, { type: 'setScoreLimit', value: 7, byPlayer: null });
    expect(room.scoreLimit).toBe(7);
  });
});

describe('stadium cache', () => {
  it('parses a stadium once while it is in use and forgets the oldest of many', () => {
    const source = customStadium((raw) => (raw.name = 'cached'));
    const first = getStadium(source);
    expect(getStadium(source)).toBe(first);
    for (let i = 0; i < 8; i++) getStadium(customStadium((raw) => (raw.name = `other ${i}`)));
    expect(getStadium(source)).not.toBe(first);
    expect(getStadium(source)).toEqual(first);
  });
});

describe('per-player physics', () => {
  const setPhysics = (room: ReturnType<typeof newRoom>, playerId: number, physics: Record<string, number | undefined> | null) =>
    applyEvent(room, { type: 'setPlayerPhysics', playerId, physics });

  it('moves only the changed player faster and keeps a radius change across kickoffs until cleared', () => {
    const room = started();
    setPhysics(room, 1, { acceleration: 0.3, radius: 20 });
    expect(disc(room, 1).radius).toBe(20);
    expect(disc(room, 2).radius).toBe(15);
    applyEvent(room, { type: 'input', playerId: 1, input: InputFlags.up });
    applyEvent(room, { type: 'input', playerId: 2, input: InputFlags.up });
    step(room, 20);
    expect(Math.abs(disc(room, 1).pos.y)).toBeGreaterThan(2 * Math.abs(disc(room, 2).pos.y));
    score(room, Team.blue);
    stepUntil(room, 'positionsReset');
    expect(disc(room, 1).radius).toBe(20);
    setPhysics(room, 1, null);
    expect(disc(room, 1).radius).toBe(15);
    expect(room.players.find((p) => p.id === 1)?.physics).toBeUndefined();
  });

  it('treats an empty or undefined-only change as none, so every peer keeps the same state', () => {
    const room = started();
    setPhysics(room, 1, { radius: undefined });
    expect(room.players.find((p) => p.id === 1)?.physics).toBeUndefined();
    expect(disc(room, 1).radius).toBe(15);
  });

  it('travels in snapshots and events and changes the state hash', () => {
    const room = started();
    const before = hashRoom(room);
    setPhysics(room, 2, { kickStrength: 9 });
    expect(hashRoom(room)).not.toBe(before);
    const sent = decodeServerMessage(encodeServerMessage({ type: 'snapshot', tick: 1, room }));
    expect(sent.type === 'snapshot' && sent.room.players.find((p) => p.id === 2)?.physics).toEqual({ kickStrength: 9 });
    const ev = decodeServerMessage(encodeServerMessage({ type: 'events', tick: 1, events: [{ type: 'setPlayerPhysics', playerId: 2, physics: { radius: 3, kickback: 1 } }] }));
    expect(ev).toEqual({ type: 'events', tick: 1, events: [{ type: 'setPlayerPhysics', playerId: 2, physics: { radius: 3, kickback: 1 } }] });
    expect(hashRoom(cloneRoom(room))).toBe(hashRoom(room));
  });
});

describe('host hud and camera', () => {
  const item = (text: string) => ({ text, x: 0.5, y: 0.1, align: 'center' as const, color: 0xffffff, size: 20 });

  it('adds, replaces in place and removes hud items, and keeps them out of the state hash', () => {
    const room = started();
    const before = hashRoom(room);
    applyEvent(room, { type: 'setHudItem', id: 'a', item: item('one') });
    applyEvent(room, { type: 'setHudItem', id: 'b', item: item('two') });
    const kept = cloneRoom(room);
    applyEvent(room, { type: 'setHudItem', id: 'a', item: item('uno') });
    expect(room.hud.map((h) => `${h.id}:${h.text}`)).toEqual(['a:uno', 'b:two']);
    expect(kept.hud.map((h) => h.text)).toEqual(['one', 'two']);
    applyEvent(room, { type: 'setHudItem', id: 'a', item: null });
    expect(room.hud.map((h) => h.id)).toEqual(['b']);
    applyEvent(room, { type: 'setCamera', camera: { follow: { type: 'player', id: 1 }, zoom: 2 } });
    expect(hashRoom(room)).toBe(before);
  });

  it('travels in snapshots and events', () => {
    const room = started();
    applyEvent(room, { type: 'setHudItem', id: 'score', item: { ...item('Red 2 - 1 Blue'), align: 'left', color: 0xff0000 } });
    applyEvent(room, { type: 'setCamera', camera: { follow: { type: 'point', x: 10, y: -5 }, zoom: 1.5 } });
    const sent = decodeServerMessage(encodeServerMessage({ type: 'snapshot', tick: 1, room }));
    expect(sent.type === 'snapshot' && { hud: sent.room.hud, camera: sent.room.camera }).toEqual({ hud: room.hud, camera: room.camera });
    const events = [
      { type: 'setHudItem', id: 'x', item: null },
      { type: 'setCamera', camera: { follow: { type: 'disc', index: 3 }, zoom: 1 } },
      { type: 'setCamera', camera: { follow: null, zoom: 0.5 } },
    ] as const;
    expect(decodeServerMessage(encodeServerMessage({ type: 'events', tick: 2, events: [...events] }))).toEqual({ type: 'events', tick: 2, events });
  });
});

describe('script joints and breaking', () => {
  const rigid = { strength: Infinity, color: 0xffffff, breakLength: Infinity };

  it('ties the ball to a player at their distance, follows the player and rests while they are off the field', () => {
    const room = started();
    applyEvent(room, { type: 'addJoint', joint: { a: { disc: 0 }, b: { player: 1 }, length: null, ...rigid } });
    const gap = Math.abs(game(room).discs[0].pos.x - disc(room, 1).pos.x);
    expect(game(room).joints.at(-1)).toMatchObject({ minLength: gap, maxLength: gap });
    applyEvent(room, { type: 'input', playerId: 1, input: InputFlags.left });
    step(room, 30);
    const ball = game(room).discs[0].pos;
    const own = disc(room, 1).pos;
    expect(Math.hypot(ball.x - own.x, ball.y - own.y)).toBeCloseTo(gap, 0);
    expect(ball.x).toBeLessThan(-5);

    applyEvent(room, { type: 'setTeam', playerId: 1, team: Team.spectators, byPlayer: null, announce: false });
    expect(() => step(room, 5)).not.toThrow();
    expect(game(room).joints).toHaveLength(1);
    applyEvent(room, { type: 'removeJoint', index: 0 });
    expect(game(room).joints).toEqual([]);
  });

  it('breaks a joint stretched past its breakLength, reporting it once', () => {
    const room = started((r) => {
      r.stadiumSource = customStadium((raw) => {
        raw.discs = [{ pos: [0, 100], radius: 5 }, { pos: [0, 140], radius: 5 }];
        raw.joints = [{ d0: 1, d1: 2, strength: 0.01, breakLength: 60 }];
      });
    });
    expect(game(room).joints).toEqual([{ a: { disc: 1 }, b: { disc: 2 }, minLength: 40, maxLength: 40, strength: 0.01, color: 0, breakLength: 60 }]);
    applyEvent(room, { type: 'setDiscProperties', discIndex: 2, props: props({ yspeed: 10 }) });
    const broke = step(room, 10).filter((o) => o.type === 'jointBreak');
    expect(broke).toEqual([{ type: 'jointBreak', index: 0 }]);
    expect(game(room).joints).toEqual([]);
  });

  it('keeps joints in the state hash and in snapshots', () => {
    const room = started();
    const before = hashRoom(room);
    applyEvent(room, { type: 'addJoint', joint: { a: { disc: 0 }, b: { player: 2 }, length: [10, 80], strength: 0.5, color: -1, breakLength: 200 } });
    expect(hashRoom(room)).not.toBe(before);
    const sent = decodeServerMessage(encodeServerMessage({ type: 'snapshot', tick: 1, room }));
    expect(sent.type === 'snapshot' && sent.room.game?.joints).toEqual(game(room).joints);
  });
});

describe('host room and game changes', () => {
  it('renames the room and teams and rewrites the running game, travelling as events', () => {
    const room = started();
    const events = [
      { type: 'setRoomProps', name: 'League night', maxPlayers: 10 },
      { type: 'setTeamName', team: Team.red, name: 'Lions' },
      { type: 'setGameProps', red: 3, blue: null, time: 120, scoreLimit: 0, timeLimit: 7 },
      { type: 'addJoint', joint: { a: { disc: 0 }, b: { player: 1 }, length: null, strength: Infinity, color: -1, breakLength: Infinity } },
      { type: 'removeJoint', index: 2 },
    ] as const;
    expect(decodeServerMessage(encodeServerMessage({ type: 'events', tick: 2, events: [...events] }))).toEqual({ type: 'events', tick: 2, events });
    for (const ev of events.slice(0, 3)) applyEvent(room, ev);
    expect(room).toMatchObject({ name: 'League night', maxPlayers: 10, redName: 'Lions', blueName: '' });
    expect(game(room)).toMatchObject({ red: 3, blue: 0, time: 120, scoreLimit: 0, timeLimit: 7 });
    const sent = decodeServerMessage(encodeServerMessage({ type: 'snapshot', tick: 1, room }));
    expect(sent.type === 'snapshot' && sent.room.redName).toBe('Lions');
  });
});
