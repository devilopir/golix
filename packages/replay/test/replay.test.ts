import { InputFlags, Team, Writer, applyEvent, createRoomState, hashRoom, stepRoom, writeRoom, type DiscProperties, type RoomEvent, type RoomState } from '@golix/shared';
import { describe, expect, it } from 'vitest';
import { REPLAY_VERSION, ReplayError, ReplayPlayer, ReplayRecorder, decodeReplay, encodeReplay, trimReplay, type Replay } from '../src/index.ts';

const TICKS = 3000;
const INTERVAL = 250;
const RESYNC_AT = 1700;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function props(p: Partial<DiscProperties>): DiscProperties {
  return { x: null, y: null, xspeed: null, yspeed: null, xgravity: null, ygravity: null, radius: null, bCoeff: null, invMass: null, damping: null, color: null, cMask: null, cGroup: null, ...p };
}

function lobby(): RoomState {
  const room = createRoomState({ name: 'replay test', maxPlayers: 12, hasPassword: false });
  for (const ev of [
    { type: 'setTimeLimit', value: 0, byPlayer: null },
    { type: 'setScoreLimit', value: 0, byPlayer: null },
  ] satisfies RoomEvent[]) applyEvent(room, ev);
  for (const id of [1, 2, 3]) {
    applyEvent(room, { type: 'playerJoin', player: { id, name: `p${id}`, team: Team.spectators, admin: id === 1, avatar: '', country: 'tr', joinSeq: id, ping: 0 } });
  }
  return room;
}

function script(room: RoomState, t: number, rand: () => number): RoomEvent[] {
  if (t === 1) return [
    { type: 'setTeam', playerId: 1, team: Team.red, byPlayer: 1, announce: false },
    { type: 'setTeam', playerId: 2, team: Team.blue, byPlayer: 1, announce: false },
    { type: 'startGame', byPlayer: 1 },
  ];
  const events: RoomEvent[] = [];
  const g = room.game;
  if (g === null) return events;
  if (t % 400 === 0 && (g.phase === 'kickoff' || g.phase === 'playing')) {
    const goal = g.stadium.goals[(t / 400) % 2];
    const dir = goal.p0.x < 0 ? -1 : 1;
    events.push({ type: 'setDiscProperties', discIndex: 0, props: props({ x: goal.p0.x - dir * 20, y: 0, xspeed: dir * 6, yspeed: 0 }) });
  }
  const ball = g.discs[0].pos;
  for (const p of g.players) {
    if (p.disc === null || rand() % 6 !== 0) continue;
    let input = ball.x > p.disc.pos.x ? InputFlags.right : InputFlags.left;
    input |= ball.y > p.disc.pos.y ? InputFlags.down : InputFlags.up;
    if (rand() % 3 === 0) input |= InputFlags.kick;
    events.push({ type: 'input', playerId: p.id, input });
  }
  if (t === 900) events.push({ type: 'chat', playerId: 2, text: 'nice one' });
  if (t === 1200) events.push({ type: 'setPaused', paused: true, byPlayer: 1 });
  if (t === 1300) events.push({ type: 'setPaused', paused: false, byPlayer: 1 });
  if (t === 2100) events.push({ type: 'setTeam', playerId: 3, team: Team.blue, byPlayer: 1, announce: false });
  if (t === 2500) events.push({ type: 'playerLeave', playerId: 2, kicked: false, ban: false, reason: '', byPlayer: null });
  return events;
}

/** Plays the script like a server and records it; hashes[n] is the room hash after n frames. */
function recordMatch(): { bytes: Uint8Array<ArrayBuffer>; hashes: number[] } {
  const room = lobby();
  const recorder = new ReplayRecorder(room);
  const hashes = [hashRoom(room)];
  const rand = prng(7);
  for (let t = 1; t <= TICKS; t++) {
    const events = script(room, t, rand);
    for (const ev of events) applyEvent(room, ev);
    stepRoom(room);
    if (t === RESYNC_AT) recorder.resync();
    if (t === 600 || t === 601) recorder.setHandicap(1, 40);
    if (t === 2000) recorder.setHandicap(1, 0);
    recorder.tick(events, room);
    hashes.push(hashRoom(room));
  }
  return { bytes: recorder.finish(), hashes };
}

const match = recordMatch();

function linearHashes(player: ReplayPlayer): number[] {
  const hashes = [hashRoom(player.room)];
  while (player.stepFrame() !== null) hashes.push(hashRoom(player.room));
  return hashes;
}

describe('replay format', () => {
  it('decodes what it encodes, with empty frames run-length encoded', () => {
    const replay = decodeReplay(match.bytes);
    expect(replay.frames).toHaveLength(TICKS);
    expect(replay.frames[RESYNC_AT - 1].kind).toBe('snapshot');
    expect(replay.frames.filter((f) => f.kind === 'snapshot')).toHaveLength(1);
    expect(decodeReplay(encodeReplay(replay))).toEqual(replay);
    expect(encodeReplay(replay)).toEqual(match.bytes);

    const idle: Replay = { start: replay.start, frames: Array.from({ length: 100_000 }, () => ({ kind: 'events', events: [] })), handicaps: [] };
    expect(encodeReplay(idle).length - encodeReplay({ start: replay.start, frames: [], handicaps: [] }).length).toBeLessThan(4);
    expect(decodeReplay(encodeReplay(idle)).frames).toHaveLength(100_000);
  });

  it('trims to a range that plays back like that part of the original, with the handicaps in effect', () => {
    const replay = decodeReplay(match.bytes);
    const clip = decodeReplay(encodeReplay(trimReplay(replay, 1500, 2200)));
    expect(clip.frames).toHaveLength(700);
    expect(clip.handicaps).toEqual([
      { frame: 0, playerId: 1, ms: 40 },
      { frame: 499, playerId: 1, ms: 0 },
    ]);
    expect(linearHashes(new ReplayPlayer(clip))).toEqual(match.hashes.slice(1500, 2201));
    expect(trimReplay(replay, 0, TICKS)).toEqual(replay);
    expect(() => trimReplay(replay, 10, 5)).toThrow(RangeError);
    expect(() => trimReplay(replay, 0, TICKS + 1)).toThrow(RangeError);
  });

  it('keeps the handicap changes with the frame they took effect', () => {
    expect(decodeReplay(match.bytes).handicaps).toEqual([
      { frame: 599, playerId: 1, ms: 40 },
      { frame: 1999, playerId: 1, ms: 0 },
    ]);
  });

  it('rejects files that are not replays, other versions and corrupt data with a clear error', () => {
    const fail = (data: Uint8Array) => {
      try {
        decodeReplay(data);
      } catch (e) {
        expect(e).toBeInstanceOf(ReplayError);
        return (e as Error).message;
      }
      throw new Error('decoded');
    };
    expect(fail(new TextEncoder().encode('{"name": "stadium"}'))).toBe("Couldn't load the file.");
    expect(fail(new Uint8Array([0x47, 0x4c]))).toBe("Couldn't load the file.");

    const other = match.bytes.slice();
    other[4] = REPLAY_VERSION + 1;
    expect(fail(other)).toBe('The replay file is of a different version');
    other[4] = REPLAY_VERSION - 1;
    expect(fail(other)).toBe('Incompatible replay version');

    for (const corrupt of [match.bytes.slice(0, match.bytes.length - 3), match.bytes.slice(0, 200), new Uint8Array([...match.bytes, 0, 9])]) {
      expect(fail(corrupt)).not.toMatch(/^Replay error/);
    }

    const header = (handicaps: number[][]) => {
      const w = new Writer();
      for (const b of [0x47, 0x4c, 0x58, 0x52]) w.u8(b);
      w.uint(REPLAY_VERSION);
      w.uint(2);
      writeRoom(w, lobby());
      w.uint(handicaps.length);
      for (const values of handicaps) values.forEach((v) => w.uint(v));
      return w;
    };
    expect(fail(header([[3, 1, 40]]).finish())).toBe('handicap at frame 3 is past the end');
    const w = header([]);
    w.uint(5);
    expect(fail(w.finish())).toBe('more frames than the header declares');
  });
});

describe('replay player', () => {
  it('rebuilds the recorded match with identical hashes at every keyframe and at the end', () => {
    const player = new ReplayPlayer(decodeReplay(match.bytes), INTERVAL);
    expect(player.totalFrames).toBe(TICKS);
    expect(player.marks.filter((m) => m.outcome.type === 'goal').length).toBeGreaterThanOrEqual(5);
    for (let f = 0; f <= TICKS; f += INTERVAL) {
      player.seek(f);
      expect(hashRoom(player.room), `frame ${f}`).toBe(match.hashes[f]);
    }
    player.seek(TICKS);
    expect(hashRoom(player.room)).toBe(match.hashes[TICKS]);
    expect(linearHashes(new ReplayPlayer(decodeReplay(match.bytes), INTERVAL))).toEqual(match.hashes);
  });

  it('seeking backward and forward lands on the same state as linear playback', () => {
    const player = new ReplayPlayer(decodeReplay(match.bytes), INTERVAL);
    const rand = prng(3);
    for (const target of [2999, 10, 1700, 1699, 1701, 0, 2400, 2401, 250, 3000, ...Array.from({ length: 20 }, () => rand() % (TICKS + 1))]) {
      player.seek(target);
      expect(player.frame).toBe(target);
      expect(hashRoom(player.room), `frame ${target}`).toBe(match.hashes[target]);
    }
    player.seek(-5);
    expect(player.frame).toBe(0);
    player.seek(TICKS + 99);
    expect(player.frame).toBe(TICKS);
    expect(player.stepFrame()).toBeNull();
  });

  it('reports the recorded handicap at the current frame', () => {
    const player = new ReplayPlayer(decodeReplay(match.bytes), INTERVAL);
    const at = (frame: number) => {
      player.seek(frame);
      return [player.handicap(1), player.handicap(2)];
    };
    expect([at(598), at(599), at(1998), at(1999), at(0)]).toEqual([[0, 0], [40, 0], [40, 0], [0, 0], [0, 0]]);
  });

  it('plays at 0.5x to 4x, reports events as they happen and pauses at the end', () => {
    const player = new ReplayPlayer(decodeReplay(match.bytes), INTERVAL);
    expect(player.advance(1000)).toEqual([]);
    player.play();
    expect(player.advance(1000)).toHaveLength(60);
    player.speed = 2;
    expect(player.advance(500)).toHaveLength(60);
    player.speed = 0.5;
    expect(player.advance(1000)).toHaveLength(30);
    player.speed = 4;
    expect(player.advance(250)).toHaveLength(60);
    expect(player.frame).toBe(210);
    expect(() => (player.speed = 8)).toThrow(RangeError);
    expect(() => (player.speed = 0.25)).toThrow(RangeError);
    expect(player.speed).toBe(4);

    player.seek(890);
    const chat = player.advance(1000).flatMap((r) => r.events).filter((ev) => ev.type === 'chat');
    expect(chat).toEqual([{ type: 'chat', playerId: 2, text: 'nice one' }]);
    expect(player.timeAt(player.frame)).toBeGreaterThan(0);
    expect(player.timeAt(0)).toBeNaN();

    player.seek(TICKS - 10);
    expect(player.advance(1000)).toHaveLength(10);
    expect(player.playing).toBe(false);
    player.play();
    expect(player.frame).toBe(0);
  });
});
