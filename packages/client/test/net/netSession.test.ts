import { ActionFlags, InputFlags, Team, cloneRoom, decodeClientMessage, hashRoom, stepRoom, type RoomState } from '@golix/shared';
import { Room } from '@golix/room';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinError, NetSession } from '../../src/net/netSession.ts';
import { loadIdentity, signNonce } from '../../src/settings/identity.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { Link, joinInProcess } from './harness.ts';

const TICK_MS = 1000 / 60;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function disc(room: RoomState, id: number) {
  const d = room.game?.players.find((p) => p.id === id)?.disc;
  if (!d) throw new Error(`player ${id} has no disc`);
  return d;
}

/** Advances time one tick per server tick and delivers traffic on the given links. */
function run(room: Room, ticks: number, links: Link[]): void {
  for (let i = 0; i < ticks; i++) {
    vi.advanceTimersByTime(TICK_MS);
    for (const l of links) l.flushUp();
    room.runTick();
    for (const l of links) l.flushDown();
  }
}

async function match() {
  const room = new Room({ name: 'test', maxPlayers: 4 });
  const a = await joinInProcess(room, 'alice');
  const b = await joinInProcess(room, 'bob');
  const links = [a.link, b.link];
  a.session.send({ type: 'request', event: { type: 'setTeam', playerId: a.session.playerId, team: Team.red, byPlayer: null, announce: false } });
  a.session.send({ type: 'request', event: { type: 'setTeam', playerId: b.session.playerId, team: Team.blue, byPlayer: null, announce: false } });
  a.session.send({ type: 'request', event: { type: 'startGame', byPlayer: null } });
  run(room, 5, links);
  return { room, a: a.session, b: b.session, links };
}

describe('NetSession', () => {
  it('rejects with the server reason', async () => {
    const room = new Room({ name: 'test', maxPlayers: 1 });
    await joinInProcess(room, 'alice');
    const link = new Link(room);
    const promise = NetSession.join({ url: 'local', join: { name: 'bob', avatar: '', country: '', password: '', auth: '' }, connect: link.connect });
    link.flushDown();
    link.flushUp();
    link.flushDown();
    await expect(promise).rejects.toEqual(new JoinError('full'));
  });

  it('answers the server challenge with a signature the room accepts for the auth id', async () => {
    const room = new Room({ name: 'test', maxPlayers: 2 });
    const identity = await loadIdentity(new MemoryStorage());
    const link = new Link(room);
    const promise = NetSession.join({ url: 'local', join: { name: 'alice', avatar: '', country: '', password: '', auth: identity.authId }, sign: (nonce) => signNonce(identity, nonce), connect: link.connect });
    expect(link.up).toEqual([]);
    link.flushDown();
    await vi.waitFor(() => expect(link.up).toHaveLength(1));
    link.flushUp();
    room.runTick();
    link.flushDown();
    const session = await promise;
    expect(room.peerInfo(session.playerId)?.auth).toBe(identity.authId);
  });

  it('sends no action keys until the room turns them on', async () => {
    const { room, a, links } = await match();
    const sentInputs = () => links[0].up.map((d) => decodeClientMessage(d)).flatMap((m) => (m.type === 'input' ? [m.input] : []));
    links[0].up.length = 0;
    a.sendInput(ActionFlags[2]);
    expect(sentInputs()).toEqual([]);
    room.hostEvent({ type: 'setActionKeys', enabled: true });
    run(room, 2, links);
    a.sendInput(ActionFlags[2]);
    expect(sentInputs()).toEqual([ActionFlags[2]]);
  });

  it('moves the local player on the very next frame, before the server has seen the input', async () => {
    const { a } = await match();
    const before = a.getRenderStates(performance.now());
    expect(disc(before.curr, a.playerId).speed).toEqual({ x: 0, y: 0 });
    const x0 = disc(before.curr, a.playerId).pos.x;

    a.sendInput(InputFlags.right);
    vi.advanceTimersByTime(TICK_MS);
    const next = a.getRenderStates(performance.now());
    expect(disc(next.curr, a.playerId).pos.x).toBeGreaterThan(x0);
    expect(disc(a.getRoom(), a.playerId).pos.x).toBe(x0);
  });

  it('draws ahead by the extrapolation while the server still applies inputs on the next ticks', async () => {
    const { room, a, links } = await match();
    a.setExtrapolation(500);
    const x0 = disc(a.getRoom(), a.playerId).pos.x;
    a.sendInput(InputFlags.right);
    run(room, 3, links);
    expect(disc(a.getRoom(), a.playerId).pos.x).toBeGreaterThan(x0);
    const drawn = a.getRenderStates(performance.now()).curr.game!.tick;
    expect(drawn - a.getRoom().game!.tick).toBeGreaterThanOrEqual(29);
  });

  it('keeps remote players on their last confirmed input and converges after a late remote input', async () => {
    const { room, a, b, links } = await match();
    b.sendInput(InputFlags.up);
    run(room, 10, [links[0]]);
    const stale = a.getRenderStates(performance.now()).curr;
    expect(disc(stale, b.playerId).speed).toEqual({ x: 0, y: 0 });

    run(room, 20, links);
    const { curr } = a.getRenderStates(performance.now());
    const ahead = (curr.game?.tick ?? 0) - (room.state.game?.tick ?? 0);
    expect(ahead).toBeGreaterThan(0);
    const reference = cloneRoom(room.state);
    for (let i = 0; i < ahead; i++) stepRoom(reference);
    expect(hashRoom(curr)).toBe(hashRoom(reference));
    expect(disc(curr, b.playerId).pos.y).toBeLessThan(disc(stale, b.playerId).pos.y);
  });

  it('replays own inputs the server placed later than predicted', async () => {
    const { room, a, links } = await match();
    a.sendInput(InputFlags.down | InputFlags.kick);
    run(room, 3, [links[1]]);
    run(room, 10, links);
    a.sendInput(0);
    run(room, 10, links);
    expect(hashRoom(a.getRoom())).toBe(hashRoom(room.state));
    const { curr } = a.getRenderStates(performance.now());
    const reference = cloneRoom(room.state);
    for (let i = (room.state.game?.tick ?? 0); i < (curr.game?.tick ?? 0); i++) stepRoom(reference);
    expect(hashRoom(curr)).toBe(hashRoom(reference));
  });

  it('reports every confirmed tick with its outcomes, after the tick is applied', async () => {
    const { room, a, links } = await match();
    const seen: { tick: number; types: string[]; game: boolean }[] = [];
    a.onTick((tick, outcomes) => seen.push({ tick, types: outcomes.map((o) => o.type), game: a.getRoom().game !== null }));
    run(room, 2, links);
    a.send({ type: 'request', event: { type: 'stopGame', byPlayer: null } });
    run(room, 2, links);
    expect(seen.map((s) => s.tick)).toEqual([room.tick - 3, room.tick - 2, room.tick - 1, room.tick]);
    expect(seen.find((s) => s.types.includes('gameStop'))).toMatchObject({ game: false });
    expect(seen.filter((s) => s.types.length > 0)).toHaveLength(1);
  });

  it('detects a desync from the server hash and recovers through a snapshot', async () => {
    const { room, a, links } = await match();
    let resyncs = 0;
    a.onResync(() => resyncs++);
    let tampered = false;
    links[0].tamper = (msg) => {
      if (tampered || msg.type !== 'events') return msg;
      tampered = true;
      return { ...msg, events: [{ type: 'setDiscProperties', discIndex: 0, props: { x: 50, y: null, xspeed: null, yspeed: null, xgravity: null, ygravity: null, radius: null, bCoeff: null, invMass: null, damping: null, color: null, cMask: null, cGroup: null } }] };
    };
    run(room, 60, links);
    expect(a.sync.desyncs).toBe(1);
    run(room, 61, links);
    expect(a.sync.desyncs).toBe(1);
    expect(a.sync.checked).toBeGreaterThanOrEqual(2);
    expect(hashRoom(a.getRoom())).toBe(hashRoom(room.state));
    expect(resyncs).toBe(1);
  });

  it('delays outgoing messages by the handicap, in order', async () => {
    const { room, a, links } = await match();
    a.setHandicap(100);
    a.sendInput(InputFlags.left);
    a.send({ type: 'chat', text: 'hi' });
    vi.advanceTimersByTime(99);
    expect(links[0].up).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(links[0].up).toHaveLength(2);
    run(room, 3, links);
    expect(room.state.game?.players.find((p) => p.id === a.playerId)?.input).toBe(InputFlags.left);
  });

  it('validates the extrapolation range and reports how the connection ended', async () => {
    const { a } = await match();
    expect(() => a.setExtrapolation(1001)).toThrow(RangeError);
    expect(() => a.setExtrapolation(-201)).toThrow(RangeError);
    a.setExtrapolation(-200);
    const reasons: string[] = [];
    a.onClose((r) => reasons.push(r));
    a.leave();
    expect(reasons).toEqual(['left']);
  });

  it('ends within a second of the lobby reporting the host gone once the host stops sending, but not while it still does', async () => {
    const { room, a, links } = await match();
    const reasons: string[] = [];
    a.onClose((r) => reasons.push(r));
    links[0]!.hostAway();
    run(room, 300, links);
    expect(reasons).toEqual([]);
    links[0]!.hostAway();
    vi.advanceTimersByTime(999);
    expect(reasons).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reasons).toEqual(['host']);
  });

  it('gives up on a server that stops sending', async () => {
    const { room, a, links } = await match();
    const reasons: string[] = [];
    a.onClose((r) => reasons.push(r));
    run(room, 300, links);
    vi.advanceTimersByTime(9_999);
    expect(reasons).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reasons).toEqual(['timeout']);
    run(room, 1, links);
    expect(reasons).toEqual(['timeout']);
  });
});
