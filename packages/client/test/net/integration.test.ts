import { InputFlags, Team, hashRoom, type RoomState } from '@golix/shared';
import { Room } from '@golix/room';
import { createServer, type GolixServer } from '@golix/server';
import { afterEach, describe, expect, it } from 'vitest';
import { NetSession } from '../../src/net/netSession.ts';
import { joinConnect, type Connect } from '../../src/net/transport.ts';

const ONE_WAY_MS = 100;
const JITTER_MS = 20;
const LOSS = 0.02;
const RETRANSMIT_MS = 200;
const MATCH_TICKS = 660;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Ordered delivery with latency and jitter; a "lost" message is held as if retransmitted and blocks those behind it. */
function delayLine<T>(rand: () => number, deliver: (item: T) => void): (item: T) => void {
  const queue: { at: number; item: T }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const flush = () => {
    timer = null;
    const now = performance.now();
    while (queue.length > 0 && queue[0].at <= now) deliver((queue.shift() as { item: T }).item);
    if (queue.length > 0) timer = setTimeout(flush, queue[0].at - now);
  };
  return (item) => {
    let at = performance.now() + ONE_WAY_MS + (rand() * 2 - 1) * JITTER_MS;
    if (rand() < LOSS) at += RETRANSMIT_MS;
    last = Math.max(at, last);
    queue.push({ at: last, item });
    if (timer === null) timer = setTimeout(flush, last - performance.now());
  };
}

function lossyConnect(rand: () => number): Connect {
  return (url, handlers) => {
    const inbound = delayLine<Uint8Array | null>(rand, (d) => (d === null ? handlers.close() : handlers.message(d)));
    const transport = joinConnect()(url, { message: inbound, close: () => inbound(null) });
    const outbound = delayLine<Uint8Array<ArrayBuffer>>(rand, (d) => transport.send(d));
    return {
      path: transport.path,
      get resuming() {
        return transport.resuming;
      },
      send: outbound,
      close: () => transport.close(),
    };
  };
}

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (cond()) resolve();
      else if (performance.now() - start > timeoutMs) reject(new Error('timed out'));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function disc(room: RoomState, id: number) {
  const d = room.game?.players.find((p) => p.id === id)?.disc;
  if (!d) throw new Error(`player ${id} has no disc`);
  return d;
}

let server: GolixServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('four clients relayed to a server room over localhost with 100 ms latency, jitter and loss bursts', () => {
  it('stays in sync through a match with random inputs and a goal', { timeout: 40_000 }, async () => {
    server = await createServer({ port: 0 });
    const room = new Room({ name: 'Match', maxPlayers: 12 });
    const id = server.addRoom(room, { name: 'Match', maxPlayers: 12, public: true, country: '', lat: 0, lon: 0 });
    room.start();
    const url = `ws://127.0.0.1:${server.port}/room/${id}`;
    const rand = prng(7);
    const sessions: NetSession[] = [];
    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      sessions.push(await NetSession.join({ url, join: { name, avatar: '', country: 'tr', password: '', auth: name }, connect: lossyConnect(rand) }));
    }
    const [admin] = sessions;
    const teams = [Team.red, Team.red, Team.blue, Team.blue];
    sessions.forEach((s, i) => admin.send({ type: 'request', event: { type: 'setTeam', playerId: s.playerId, team: teams[i], byPlayer: null, announce: false } }));
    admin.send({ type: 'request', event: { type: 'setScoreLimit', value: 0, byPlayer: null } });
    admin.send({ type: 'request', event: { type: 'setTimeLimit', value: 0, byPlayer: null } });
    admin.send({ type: 'request', event: { type: 'startGame', byPlayer: null } });
    await waitFor(() => sessions.every((s) => s.getRoom().game !== null));
    await sleep(1500);

    const still = admin.getRenderStates(performance.now()).curr;
    expect(disc(still, admin.playerId).speed).toEqual({ x: 0, y: 0 });
    admin.sendInput(InputFlags.right);
    await sleep(16);
    const moved = admin.getRenderStates(performance.now()).curr;
    expect(disc(moved, admin.playerId).pos.x).toBeGreaterThan(disc(still, admin.playerId).pos.x);

    const start = room.tick;
    let goalSent = false;
    while (room.tick < start + MATCH_TICKS) {
      for (const s of sessions) {
        if (rand() < 0.15) s.sendInput(Math.floor(rand() * 32));
        s.getRenderStates(performance.now());
      }
      if (!goalSent && room.tick >= start + MATCH_TICKS / 2) {
        goalSent = true;
        room.hostEvent({ type: 'setDiscProperties', discIndex: 0, props: { x: 330, y: 0, xspeed: 12, yspeed: 0, xgravity: null, ygravity: null, radius: null, bCoeff: null, invMass: null, damping: null, color: null, cMask: null, cGroup: null } });
      }
      await sleep(16);
    }
    for (const s of sessions) s.sendInput(0);
    await sleep(1200);
    room.stop();
    await sleep(800);

    expect(room.state.game?.red).toBe(1);
    const serverHash = hashRoom(room.state);
    for (const s of sessions) {
      expect(s.sync.desyncs).toBe(0);
      expect(s.sync.checked).toBeGreaterThanOrEqual(MATCH_TICKS / 60);
      expect(hashRoom(s.getRoom())).toBe(serverHash);
      const { curr } = s.getRenderStates(performance.now());
      expect(curr.game?.red).toBe(1);
    }
    for (const s of sessions) s.leave();
  });
});
