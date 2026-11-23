import { HASH_INTERVAL, InputFlags, PROTOCOL_VERSION, Team, encodeClientMessage, hashRoom, verifiedMessage, type RoomEvent } from '@golix/shared';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../src/index.ts';
import { FakePeer, joinAll, signNonce, testKey } from './helpers.ts';

function newRoom(maxPlayers = 12) {
  return new Room({ name: 'test', maxPlayers });
}

function pastRaidGrace(room: Room) {
  for (let i = 0; i < 2 * 60 * 60; i++) room.runTick();
}

function team(room: Room, id: number) {
  return room.state.players.find((p) => p.id === id)?.team;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('join handshake', () => {
  it('keeps the auth only when the join signs this connection\'s challenge with that key', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(room.peerInfo(a.playerId)?.auth).toBe(testKey('alice').authId);

    const replayed = new FakePeer(room);
    replayed.join('mallory', { key: 'alice', signature: signNonce('alice', a.nonce) });
    const forged = new FakePeer(room);
    forged.join('eve', { key: 'alice', signature: signNonce('eve', forged.nonce) });
    room.runTick();
    expect(replayed.nonce).not.toBe(a.nonce);
    expect(room.peerInfo(replayed.playerId)?.auth).toBe('');
    expect(room.peerInfo(forged.playerId)?.auth).toBe('');
  });

  it('welcomes the creator as admin and announces later joiners to everyone else', () => {
    const room = newRoom();
    const [a, b] = joinAll(room, ['alice', 'bob']);
    const welcomeA = a.last('welcome');
    expect(welcomeA?.room.players).toEqual([expect.objectContaining({ name: 'alice', admin: true, team: Team.spectators })]);
    expect(welcomeA?.tick).toBe(1);
    const welcomeB = b.last('welcome');
    expect(welcomeB?.tick).toBe(2);
    expect(welcomeB?.room.players.map((p) => [p.name, p.admin])).toEqual([['alice', true], ['bob', false]]);
    expect(a.last('events')).toEqual({ type: 'events', tick: 2, events: [{ type: 'playerJoin', player: expect.objectContaining({ name: 'bob', id: b.playerId }) }] });
    expect(b.events()).toEqual([]);
  });

  it('sends every tick, empty or not, and a hash of the state every 60 ticks', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    for (let i = 0; i < 2 * HASH_INTERVAL; i++) room.runTick();
    const ticks = a.received.filter((m) => m.type === 'events').map((m) => (m.type === 'events' ? m.tick : 0));
    expect(ticks).toEqual(Array.from({ length: 2 * HASH_INTERVAL }, (_, i) => i + 2));
    expect(a.received.filter((m) => m.type === 'hash').map((m) => (m.type === 'hash' ? m.tick : 0))).toEqual([60, 120]);
    expect(a.last('hash')?.hash).toBe(hashRoom(room.state));
  });

  it('rejects a wrong password and accepts the right one', () => {
    const room = newRoom();
    const admin = new FakePeer(room);
    admin.join('alice', { password: 'secret' });
    room.runTick();
    expect(room.state.hasPassword).toBe(true);
    const wrong = new FakePeer(room);
    wrong.join('bob', { password: 'nope' });
    expect(wrong.received).toEqual([{ type: 'joinRejected', reason: 'password' }]);
    expect(wrong.closed).toBe(true);
    const right = new FakePeer(room);
    right.join('bob', { password: 'secret' });
    room.runTick();
    expect(right.last('welcome')).toBeDefined();
  });

  it('rejects joins once the room is full, counting joins still waiting for their tick', () => {
    const room = newRoom(2);
    const a = new FakePeer(room);
    const b = new FakePeer(room);
    const c = new FakePeer(room);
    a.join('a');
    b.join('b');
    c.join('c');
    expect(c.received).toEqual([{ type: 'joinRejected', reason: 'full' }]);
    room.runTick();
    expect(room.state.players).toHaveLength(2);
  });

  it('turns away a join from another protocol version with its own reason, and garbage as invalid', () => {
    const room = newRoom();
    const attempt = (bytes: Uint8Array) => {
      const peer = new FakePeer(room);
      peer.handle.receive(bytes);
      room.runTick();
      return peer.received[0]?.type === 'joinRejected' ? peer.received[0].reason : 'joined';
    };
    const join = encodeClientMessage({ type: 'join', name: 'old', avatar: '', country: '', password: '', auth: '', signature: '', verified: '' });
    expect(join[1]).toBe(PROTOCOL_VERSION);
    const other = join.slice();
    other[1] = PROTOCOL_VERSION + 1;
    expect(attempt(other)).toBe('version');
    expect(attempt(new Uint8Array([0]))).toBe('invalid');
    expect(attempt(join)).toBe('joined');
  });

  it('rejects an empty nickname and malformed bytes', () => {
    const room = newRoom();
    const empty = new FakePeer(room);
    empty.join('');
    expect(empty.received).toEqual([{ type: 'joinRejected', reason: 'invalid' }]);
    const junk = new FakePeer(room);
    junk.handle.receive(new Uint8Array([0, 200]));
    expect(junk.received).toEqual([{ type: 'joinRejected', reason: 'invalid' }]);
  });
});

describe('permissions', () => {
  it('clamps host score and time limits to 0-99 while player requests stay within 0-14', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    room.hostEvent({ type: 'setScoreLimit', value: 150, byPlayer: null });
    room.hostEvent({ type: 'setTimeLimit', value: 40, byPlayer: null });
    room.runTick();
    expect([room.state.scoreLimit, room.state.timeLimit]).toEqual([99, 40]);
    room.hostEvent({ type: 'setScoreLimit', value: -3, byPlayer: null });
    room.hostEvent({ type: 'setTimeLimit', value: 7.8, byPlayer: null });
    room.runTick();
    expect([room.state.scoreLimit, room.state.timeLimit]).toEqual([0, 7]);
    a.request({ type: 'setScoreLimit', value: 20, byPlayer: null });
    room.runTick();
    expect(room.state.scoreLimit).toBe(0);
  });

  it('drops host events with values clients cannot read and keeps ticking', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    room.hostEvent({ type: 'startGame', byPlayer: null });
    room.runTick();
    const props = { x: null, y: null, xspeed: null, yspeed: null, xgravity: null, ygravity: null, radius: null, bCoeff: null, invMass: null, damping: null, color: null, cMask: null, cGroup: null };
    const unreadable = [
      { type: 'announcement', text: 'x', targetId: null, color: 0xffffffff, style: 'normal', sound: 1 },
      { type: 'announcement', text: 'x', targetId: null, color: 0, style: 'huge', sound: 1 },
      { type: 'setTeam', playerId: a.playerId, team: 3, byPlayer: null, announce: false },
      { type: 'setDiscProperties', discIndex: 0, props: { ...props, color: 0.5 } },
      { type: 'reorderPlayers', playerIds: [-1], moveToTop: true },
    ] as unknown as RoomEvent[];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const ev of unreadable) room.hostEvent(ev);
    room.hostEvent({ type: 'setDiscProperties', discIndex: 0, props: { ...props, color: 0xff0000 } });
    room.runTick();
    room.runTick();
    expect(a.last('events')?.tick).toBe(4);
    expect(a.events().filter((e) => e.type === 'setDiscProperties')).toHaveLength(1);
    expect(team(room, a.playerId)).toBe(Team.spectators);
    expect(console.warn).toHaveBeenCalledTimes(unreadable.length);
  });

  it('applies host physics changes for one player and drops ones that are not finite', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    room.hostEvent({ type: 'setPlayerPhysics', playerId: a.playerId, physics: { kickStrength: Number.NaN } });
    room.hostEvent({ type: 'setPlayerPhysics', playerId: a.playerId, physics: { acceleration: Infinity } });
    room.runTick();
    expect(room.state.players[0]!.physics).toBeUndefined();
    room.hostEvent({ type: 'setPlayerPhysics', playerId: a.playerId, physics: { kickStrength: 8 } });
    room.runTick();
    expect(room.state.players[0]!.physics).toEqual({ kickStrength: 8 });
    expect(a.events().filter((e) => e.type === 'setPlayerPhysics')).toHaveLength(1);
  });

  it('takes hud items and camera changes from the host only, within their ranges and up to 16 items', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    const item = { text: 'hi', x: 0.5, y: 0.5, align: 'center' as const, color: 0xffffff, size: 16 };
    a.request({ type: 'setHudItem', id: 'x', item });
    a.request({ type: 'setCamera', camera: { follow: null, zoom: 2 } });
    for (const bad of [{ ...item, x: 1.5 }, { ...item, size: 100 }, { ...item, color: -1 }]) room.hostEvent({ type: 'setHudItem', id: 'bad', item: bad });
    room.hostEvent({ type: 'setCamera', camera: { follow: null, zoom: 9 } });
    room.hostEvent({ type: 'setCamera', camera: { follow: { type: 'point', x: Number.NaN, y: 0 }, zoom: 1 } });
    room.runTick();
    expect(room.state.hud).toEqual([]);
    expect(room.state.camera).toEqual({ follow: null, zoom: 1 });
    for (let i = 0; i < 17; i++) room.hostEvent({ type: 'setHudItem', id: `i${i}`, item });
    room.hostEvent({ type: 'setHudItem', id: 'i0', item: { ...item, text: 'changed' } });
    room.runTick();
    expect(room.state.hud).toHaveLength(16);
    expect(room.state.hud[0]!.text).toBe('changed');
  });

  it('announces a team change only when an admin asked for it', () => {
    const room = newRoom();
    const [a, b] = joinAll(room, ['alice', 'bob']);
    b.request({ type: 'setTeam', playerId: b.playerId, team: Team.red, byPlayer: null, announce: true });
    room.runTick();
    expect(a.last('events')?.events).toEqual([{ type: 'setTeam', playerId: b.playerId, team: Team.red, byPlayer: b.playerId, announce: false }]);
    a.request({ type: 'setTeam', playerId: b.playerId, team: Team.blue, byPlayer: null, announce: true });
    room.runTick();
    expect(b.last('events')?.events).toEqual([{ type: 'setTeam', playerId: b.playerId, team: Team.blue, byPlayer: a.playerId, announce: true }]);
  });

  it('lets only admins start the game and change limits, and forces byPlayer to the sender', () => {
    const room = newRoom();
    const [a, b] = joinAll(room, ['alice', 'bob']);
    b.request({ type: 'setScoreLimit', value: 5, byPlayer: null });
    b.request({ type: 'startGame', byPlayer: null });
    room.runTick();
    expect(room.state.scoreLimit).toBe(3);
    expect(room.state.game).toBeNull();
    a.request({ type: 'setScoreLimit', value: 15, byPlayer: null });
    a.request({ type: 'setScoreLimit', value: 5, byPlayer: 99 });
    a.request({ type: 'startGame', byPlayer: null });
    room.runTick();
    expect(room.state.scoreLimit).toBe(5);
    expect(room.state.game).not.toBeNull();
    expect(b.last('events')?.events).toEqual([
      { type: 'setScoreLimit', value: 5, byPlayer: a.playerId },
      { type: 'startGame', byPlayer: a.playerId },
    ]);
    a.request({ type: 'setTimeLimit', value: 1, byPlayer: null });
    room.runTick();
    expect(room.state.timeLimit).toBe(3);
  });

  it('applies the teams lock and the no self move during a match rule to non-admins only', () => {
    const room = newRoom();
    const [a, b] = joinAll(room, ['alice', 'bob']);
    b.request({ type: 'setTeam', playerId: b.playerId, team: Team.red, byPlayer: null, announce: false });
    room.runTick();
    expect(team(room, b.playerId)).toBe(Team.red);

    b.request({ type: 'setTeam', playerId: a.playerId, team: Team.blue, byPlayer: null, announce: false });
    a.request({ type: 'setTeamsLock', locked: true, byPlayer: null });
    room.runTick();
    expect(team(room, a.playerId)).toBe(Team.spectators);
    b.request({ type: 'setTeam', playerId: b.playerId, team: Team.blue, byPlayer: null, announce: false });
    room.runTick();
    expect(team(room, b.playerId)).toBe(Team.red);

    a.request({ type: 'setTeamsLock', locked: false, byPlayer: null });
    a.request({ type: 'startGame', byPlayer: null });
    b.request({ type: 'setTeam', playerId: b.playerId, team: Team.blue, byPlayer: null, announce: false });
    room.runTick();
    expect(team(room, b.playerId)).toBe(Team.red);
    a.request({ type: 'setTeam', playerId: b.playerId, team: Team.blue, byPlayer: null, announce: false });
    a.request({ type: 'setTeam', playerId: a.playerId, team: Team.red, byPlayer: null, announce: false });
    room.runTick();
    expect(team(room, b.playerId)).toBe(Team.blue);
    expect(team(room, a.playerId)).toBe(Team.red);
  });

  it('refuses host-only and spoofed requests', () => {
    const room = newRoom();
    const [a, b] = joinAll(room, ['alice', 'bob']);
    const before = b.received.length;
    const props = { x: 0, y: 0, xspeed: 9, yspeed: null, xgravity: null, ygravity: null, radius: null, bCoeff: null, invMass: null, damping: null, color: null, cMask: null, cGroup: null };
    const refused: RoomEvent[] = [
      { type: 'input', playerId: b.playerId, input: InputFlags.right },
      { type: 'chat', playerId: b.playerId, text: 'spoof' },
      { type: 'announcement', text: 'x', targetId: null, color: 0, style: 'bold', sound: 1 },
      { type: 'setDiscProperties', discIndex: 0, props },
      { type: 'setPlayerDiscProperties', playerId: a.playerId, props },
      { type: 'reorderPlayers', playerIds: [b.playerId], moveToTop: true },
      { type: 'setPassword', hasPassword: true, byPlayer: null },
      { type: 'ping', pings: [[a.playerId, 1]] },
      { type: 'setAvatar', playerId: b.playerId, avatar: 'X' },
      { type: 'setTyping', playerId: b.playerId, typing: true },
      { type: 'playerLeave', playerId: a.playerId, kicked: false, ban: false, reason: '', byPlayer: null },
      { type: 'setStadium', source: '{ not json', byPlayer: null },
      { type: 'setKickRateLimit', limit: { min: 256, rate: 0, burst: 0 }, byPlayer: null },
      { type: 'setTeamColors', team: Team.red, colors: { angle: 361, textColor: 0, colors: [0] }, byPlayer: null },
      { type: 'setPlayerPhysics', playerId: b.playerId, physics: { kickStrength: 50 } },
      { type: 'setRoomProps', name: 'mine', maxPlayers: null },
      { type: 'setTeamName', team: Team.red, name: 'Lions' },
      { type: 'setGameProps', red: 5, blue: null, time: null, scoreLimit: null, timeLimit: null },
      { type: 'removeJoint', index: 0 },
    ];
    for (const event of refused) a.request(event);
    room.runTick();
    expect(b.received.slice(before)).toEqual([{ type: 'events', tick: 3, events: [] }]);

    b.request({ type: 'setAvatar', playerId: b.playerId, avatar: 'B' });
    b.request({ type: 'setTyping', playerId: b.playerId, typing: true });
    room.runTick();
    expect(b.last('events')?.events.map((e) => e.type)).toEqual(['setAvatar', 'setTyping']);
  });

  it('takes room, team name, game and joint changes from the host only within their limits', () => {
    const room = newRoom();
    const [a, b] = joinAll(room, ['alice', 'bob']);
    room.hostEvent({ type: 'setRoomProps', name: 'League', maxPlayers: 31 });
    room.hostEvent({ type: 'setRoomProps', name: 'League', maxPlayers: 4 });
    room.hostEvent({ type: 'setTeamName', team: Team.blue, name: 'Lions' });
    room.hostEvent({ type: 'setGameProps', red: 2, blue: null, time: null, scoreLimit: null, timeLimit: null });
    room.runTick();
    expect(room.state).toMatchObject({ name: 'League', maxPlayers: 4, blueName: 'Lions' });
    expect(b.last('events')?.events.map((e) => e.type)).toEqual(['setRoomProps', 'setTeamName']);

    room.hostEvent({ type: 'setTeam', playerId: a.playerId, team: Team.red, byPlayer: null, announce: false });
    room.hostEvent({ type: 'startGame', byPlayer: null });
    room.runTick();
    const end = { disc: 0 };
    const joint = { a: end, b: { player: a.playerId }, length: null, strength: Infinity, color: -1, breakLength: Infinity };
    room.hostEvent({ type: 'setGameProps', red: 2, blue: 1000, time: null, scoreLimit: null, timeLimit: null });
    room.hostEvent({ type: 'setGameProps', red: 2, blue: 1, time: 75.5, scoreLimit: 5, timeLimit: 10 });
    room.hostEvent({ type: 'addJoint', joint: { ...joint, b: { player: 99 } } });
    room.hostEvent({ type: 'addJoint', joint: { ...joint, a: { disc: room.state.game!.discs.length } } });
    room.hostEvent({ type: 'addJoint', joint: { ...joint, length: [5, 1] } });
    room.hostEvent({ type: 'addJoint', joint: { ...joint, breakLength: Number.NaN } });
    room.hostEvent({ type: 'addJoint', joint });
    room.hostEvent({ type: 'removeJoint', index: 5 });
    room.runTick();
    expect(b.last('events')?.events.map((e) => e.type)).toEqual(['setGameProps', 'addJoint']);
    expect(room.state.game).toMatchObject({ red: 2, blue: 1, time: 75.5, scoreLimit: 5, timeLimit: 10 });
    expect(room.state.game!.joints).toEqual([expect.objectContaining({ a: end, b: { player: a.playerId } })]);
  });

  it('relays inputs only as the sending player, masked to the five input bits', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    a.send({ type: 'input', tick: 0, input: 0xff });
    room.runTick();
    expect(a.last('events')?.events).toEqual([{ type: 'input', playerId: a.playerId, input: 31 }]);
  });

  it('schedules inputs at the client tick when it is ahead, otherwise at the next tick, keeping each player in order', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    a.send({ type: 'input', tick: room.tick + 3, input: InputFlags.up });
    a.send({ type: 'input', tick: 0, input: InputFlags.down });
    room.runTick();
    room.runTick();
    room.runTick();
    const ticks = a.received.flatMap((m) => (m.type === 'events' && m.events.length > 0 ? [[m.tick, m.events]] : []));
    expect(ticks).toEqual([
      [4, [
        { type: 'input', playerId: a.playerId, input: InputFlags.up },
        { type: 'input', playerId: a.playerId, input: InputFlags.down },
      ]],
    ]);
  });

  it('queues chat over the rate limit and sends one queued message every 2 s, drops empty or multi-line messages, and keeps commands out of the chat', () => {
    const room = newRoom();
    const [a, b] = joinAll(room, ['alice', 'bob']);
    for (let i = 0; i < 8; i++) b.send({ type: 'chat', text: `m${i}` });
    b.send({ type: 'chat', text: '   ' });
    b.send({ type: 'chat', text: 'two\nlines' });
    room.runTick();
    expect(a.last('events')?.events.map((e) => (e.type === 'chat' ? e.text : e.type))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    const start = room.tick;
    const later: [number, string][] = [];
    for (let i = 0; i < 400; i++) {
      room.runTick();
      for (const e of a.last('events')?.events ?? []) if (e.type === 'chat') later.push([room.tick - start, e.text]);
    }
    expect(later).toEqual([[120, 'm5'], [240, 'm6'], [360, 'm7']]);

    b.send({ type: 'setPassword', password: 'hijack' });
    a.send({ type: 'setPassword', password: 'secret' });
    room.runTick();
    expect(a.last('events')?.events).toEqual([{ type: 'setPassword', hasPassword: true, byPlayer: a.playerId }]);
    expect(room.state.hasPassword).toBe(true);
    const late = new FakePeer(room);
    late.join('carol', { password: 'hijack' });
    expect(late.last('joinRejected')?.reason).toBe('password');
    a.send({ type: 'setPassword', password: null });
    room.runTick();
    expect(room.state.hasPassword).toBe(false);
  });
});

describe('kick, ban and admin hand-over', () => {
  it('lets the newer connection of the same key replace the older one, without counting both toward a full room', () => {
    const room = newRoom(2);
    joinAll(room, ['host']);
    const first = new FakePeer(room, 'AA');
    first.join('alice');
    room.runTick();
    const again = new FakePeer(room, 'AB');
    again.join('alice again', { key: 'alice' });
    room.runTick();
    expect(first.last('disconnected')).toEqual({ type: 'disconnected', reason: 'joined again' });
    expect(again.last('welcome')).toBeDefined();
    expect(room.state.players.map((p) => p.name)).toEqual(['host', 'alice again']);
  });

  it('never replaces the in-process host when its key joins from elsewhere', () => {
    const room = newRoom();
    const host = new FakePeer(room);
    host.join('host');
    room.runTick();
    const tab = new FakePeer(room, 'AB');
    tab.join('host tab', { key: 'host' });
    room.runTick();
    expect(host.closed).toBe(false);
    expect(room.state.players.map((p) => p.name)).toEqual(['host', 'host tab']);
  });

  it('keeps a connection that flooded the room out for a minute', () => {
    const room = newRoom();
    const flooder = new FakePeer(room, 'FF');
    flooder.join('flood');
    room.runTick();
    for (let i = 0; i < 301; i++) flooder.send({ type: 'chat', text: 'x' });
    expect(flooder.last('disconnected')).toEqual({ type: 'disconnected', reason: 'flood' });
    const attempt = () => {
      const peer = new FakePeer(room, 'FF');
      peer.join('back', { key: `back${room.tick}` });
      room.runTick();
      return peer.received[0]?.type === 'joinRejected' ? peer.received[0].reason : 'joined';
    };
    expect(attempt()).toBe('rateLimited');
    for (let i = 0; i < 60 * 60; i++) room.runTick();
    expect(attempt()).toBe('joined');
  });

  it('limits how many players one address may have in the room once the host sets it', () => {
    const room = newRoom();
    const attempt = (conn: string, name: string) => {
      const peer = new FakePeer(room, conn);
      peer.join(name);
      room.runTick();
      return peer.received[0]?.type === 'joinRejected' ? peer.received[0].reason : 'joined';
    };
    expect(attempt('AA', 'a')).toBe('joined');
    expect(attempt('AA', 'b')).toBe('joined');
    room.setMaxPlayersPerConn(2);
    expect(attempt('AA', 'c')).toBe('connLimit');
    expect(attempt('BB', 'd')).toBe('joined');
    expect(attempt('', 'e')).toBe('joined');
  });

  it('guards the room for a while after a burst of joins: a captcha where the lobby has one, else the strict join limit', () => {
    for (const available of [true, false]) {
      const room = newRoom(20);
      pastRaidGrace(room);
      room.setCaptchaAvailable(available);
      room.setRaidProtection({ joins: 3, seconds: 10, minutes: 1 });
      const attempt = (conn: string, captcha = false) => {
        const peer = new FakePeer(room, conn, captcha);
        peer.join(`p${conn}`, { key: `${conn}${room.tick}` });
        room.runTick();
        return peer.received[0]?.type === 'joinRejected' ? peer.received[0].reason : 'joined';
      };
      expect(['A', 'B', 'C'].map((c) => attempt(c))).toEqual(['joined', 'joined', 'joined']);
      expect(room.captchaRequired).toBe(available);
      expect(attempt('D')).toBe(available ? 'captcha' : 'joined');
      if (available) expect(attempt('E', true)).toBe('joined');
      else expect(attempt('D')).toBe('rateLimited');
      for (let i = 0; i < 60 * 60; i++) room.runTick();
      expect(room.captchaRequired).toBe(false);
      expect(attempt('F')).toBe('joined');
    }
  });

  it('ignores bursts in the first two minutes and keys that joined before, as when a restarted room fills up again', () => {
    const room = newRoom(20);
    room.setCaptchaAvailable(true);
    const join = (c: string) => {
      new FakePeer(room, c).join(`p${c}`);
      room.runTick();
    };
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) join(c);
    expect(room.captchaRequired).toBe(false);
    pastRaidGrace(room);
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) join(c);
    expect(room.captchaRequired).toBe(false);
  });

  it('announces the raid guard once and stays quiet without protection', () => {
    const room = newRoom(20);
    const [watcher] = joinAll(room, ['host']);
    pastRaidGrace(room);
    room.setRaidProtection({ joins: 2, seconds: 10, minutes: 1 });
    for (const c of ['A', 'B', 'C']) {
      new FakePeer(room, c).join(`p${c}`);
      room.runTick();
    }
    room.runTick();
    expect(watcher.events().filter((e) => e.type === 'announcement')).toHaveLength(1);
    const calm = newRoom(20);
    pastRaidGrace(calm);
    calm.setRaidProtection(null);
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      new FakePeer(calm, c).join(`p${c}`);
      calm.runTick();
    }
    expect(calm.captchaRequired).toBe(false);
  });

  it('limits join attempts per connection, tighter in strict mode, and lets them in again after the window', () => {
    const room = newRoom();
    const attempt = (conn: string, name: string) => {
      const peer = new FakePeer(room, conn);
      peer.join(name);
      room.runTick();
      return peer.received[0]?.type === 'joinRejected' ? peer.received[0].reason : 'joined';
    };
    expect(['a', 'b', 'c', 'd', 'e'].map((n) => attempt('AA', n))).toEqual(['joined', 'joined', 'joined', 'joined', 'joined']);
    expect(attempt('AA', 'f')).toBe('rateLimited');
    expect(attempt('BB', 'g')).toBe('joined');

    room.setRequireCaptcha(true);
    expect(attempt('CC', 'h')).toBe('joined');
    expect(attempt('CC', 'i')).toBe('rateLimited');
    for (let i = 0; i < 30 * 60; i++) room.runTick();
    expect(attempt('CC', 'j')).toBe('joined');
    expect(attempt('', 'k')).toBe('joined');
    expect(attempt('', 'l')).toBe('joined');
  });

  it("lets a joiner with the lobby's unexpired proof for its own key past the captcha, and nobody with a borrowed or bad one", () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { x, y } = publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(x as string, 'base64url'), Buffer.from(y as string, 'base64url')]);
    const proof = (auth: string, expires: number) =>
      `${expires}.${sign('sha256', Buffer.from(verifiedMessage(auth, expires)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const later = Math.floor(Date.now() / 1000) + 3600;
    const room = newRoom(20);
    room.setCaptchaAvailable(true);
    room.setRequireCaptcha(true);
    const attempt = (key: string, verified: string, conn: string) => {
      const peer = new FakePeer(room, conn);
      peer.join(key, { verified });
      room.runTick();
      return peer.received[0]?.type === 'joinRejected' ? peer.received[0].reason : 'joined';
    };
    expect(attempt('alice', proof(testKey('alice').authId, later), 'A1')).toBe('captcha');
    room.setVerifyKey(point);
    expect(attempt('alice', proof(testKey('alice').authId, later), 'A2')).toBe('joined');
    expect(attempt('bob', proof(testKey('alice').authId, later), 'B1')).toBe('captcha');
    expect(attempt('carol', proof(testKey('carol').authId, Math.floor(Date.now() / 1000) - 1), 'C1')).toBe('captcha');
    expect(attempt('dave', `${later}.AAAA`, 'D1')).toBe('captcha');
    expect(attempt('erin', '', 'E1')).toBe('captcha');
  });

  it('turns away joiners without a solved captcha while the room asks for one, but never the in-process host', () => {
    const room = newRoom();
    room.setCaptchaAvailable(true);
    room.setRequireCaptcha(true);
    const attempt = (conn: string, captcha: boolean, name: string) => {
      const peer = new FakePeer(room, conn, captcha);
      peer.join(name);
      room.runTick();
      return peer.received[0]?.type === 'joinRejected' ? peer.received[0].reason : 'joined';
    };
    expect(attempt('AA', false, 'bot')).toBe('captcha');
    expect(attempt('BB', true, 'human')).toBe('joined');
    expect(attempt('', false, 'host')).toBe('joined');
    room.setRequireCaptcha(false);
    expect(attempt('CC', false, 'anyone')).toBe('joined');
  });

  it("keeps the lobby's banned auths out of the room and disconnects one already in", () => {
    const room = newRoom();
    const alice = new FakePeer(room, 'AA');
    alice.join('alice');
    room.runTick();
    room.setGlobalBans(new Set([testKey('alice').authId, testKey('bob').authId]));
    expect(alice.last('disconnected')).toEqual({ type: 'disconnected', reason: 'banned' });
    const bob = new FakePeer(room, 'BB');
    bob.join('bob');
    const carol = new FakePeer(room, 'CC');
    carol.join('carol');
    room.runTick();
    expect(bob.received[0]).toEqual({ type: 'joinRejected', reason: 'banned' });
    expect(room.state.players.map((p) => p.name)).toEqual(['carol']);
  });

  it('bans the connection too, so a new auth from the same address stays out', () => {
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    const b = new FakePeer(room, 'C0FFEE');
    b.join('bob');
    room.runTick();
    a.request({ type: 'playerLeave', playerId: b.playerId, kicked: false, ban: true, reason: '', byPlayer: null });
    room.runTick();

    const sameConn = new FakePeer(room, 'C0FFEE');
    sameConn.join('bob', { key: 'fresh key' });
    expect(sameConn.received).toEqual([{ type: 'joinRejected', reason: 'banned' }]);
    const elsewhere = new FakePeer(room, 'BEEF');
    elsewhere.join('bob', { key: 'fresh key' });
    room.runTick();
    expect(elsewhere.last('welcome')).toBeDefined();
  });

  it('kicks with a ban, disconnects the target after it sees its own leave, and clears bans on request', () => {
    const room = newRoom();
    const [a, b] = joinAll(room, ['alice', 'bob']);
    a.request({ type: 'playerLeave', playerId: b.playerId, kicked: false, ban: true, reason: 'rude', byPlayer: null });
    room.runTick();
    const leave = { type: 'playerLeave', playerId: b.playerId, kicked: true, ban: true, reason: 'rude', byPlayer: a.playerId };
    expect(b.received.slice(-2)).toEqual([{ type: 'events', tick: 3, events: [leave] }, { type: 'disconnected', reason: 'banned' }]);
    expect(b.closed).toBe(true);
    b.handle.closed();
    room.runTick();
    expect(a.last('events')?.events).toEqual([]);

    const again = new FakePeer(room);
    again.join('bob');
    expect(again.received).toEqual([{ type: 'joinRejected', reason: 'banned' }]);
    a.send({ type: 'clearBans' });
    room.runTick();
    const third = new FakePeer(room);
    third.join('bob');
    room.runTick();
    expect(third.last('welcome')).toBeDefined();
  });

  it('gives admin to the earliest joiner once the last admin leaves', () => {
    const room = newRoom();
    const [a, b, c] = joinAll(room, ['alice', 'bob', 'carol']);
    a.request({ type: 'setAdmin', playerId: c.playerId, admin: true, byPlayer: null });
    room.runTick();
    a.handle.closed();
    room.runTick();
    expect(b.last('events')?.events.map((e) => e.type)).toEqual(['playerLeave']);
    c.handle.closed();
    room.runTick();
    expect(b.last('events')?.events).toEqual([
      { type: 'playerLeave', playerId: c.playerId, kicked: false, ban: false, reason: '', byPlayer: null },
      { type: 'setAdmin', playerId: b.playerId, admin: true, byPlayer: null },
    ]);
  });

  it('keeps a new room alive until its first connection, however many ticks pass', () => {
    const onEmpty = vi.fn();
    const room = new Room({ name: 't', maxPlayers: 4, onEmpty });
    for (let i = 0; i < 120; i++) room.runTick();
    expect(onEmpty).not.toHaveBeenCalled();
    joinAll(room, ['alice']);
    room.runTick();
    expect(room.state.players).toHaveLength(1);
  });

  it('drops a silent peer after the timeout and reports empty rooms', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const onEmpty = vi.fn();
    const room = new Room({ name: 't', maxPlayers: 4, timeoutMs: 5000, onEmpty });
    const [a, b] = joinAll(room, ['alice', 'bob']);
    now += 3000;
    a.send({ type: 'pong', t: now - 40 });
    now += 3000;
    room.runTick();
    expect(b.last('disconnected')?.reason).toBe('timeout');
    room.runTick();
    expect(a.last('events')?.events).toEqual([
      { type: 'playerLeave', playerId: b.playerId, kicked: false, ban: false, reason: '', byPlayer: null },
    ]);
    a.handle.closed();
    room.runTick();
    expect(onEmpty).toHaveBeenCalledOnce();
  });
});

describe('sync support', () => {
  it('broadcasts measured round-trip times and answers a resync request with a snapshot', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const room = newRoom();
    const [a] = joinAll(room, ['alice']);
    while (room.tick % 60 !== 0) room.runTick();
    const ping = a.last('ping');
    if (ping === undefined) throw new Error('no ping');
    now += 42;
    a.send({ type: 'pong', t: ping.t });
    while (room.tick % 120 !== 0) room.runTick();
    expect(a.last('events')?.events).toEqual([{ type: 'ping', pings: [[a.playerId, 42]] }]);
    expect(room.state.players[0].ping).toBe(42);

    const [b] = joinAll(room, ['bob']);
    a.send({ type: 'resync' });
    room.runTick();
    expect(b.last('events')?.events).toEqual([{ type: 'syncChange', playerId: a.playerId, synced: false }]);
    expect(a.last('snapshot')).toEqual({ type: 'snapshot', tick: room.tick, room: room.state });
    room.runTick();
    expect(b.last('events')?.events).toEqual([{ type: 'syncChange', playerId: a.playerId, synced: true }]);
    a.send({ type: 'resync' });
    room.runTick();
    expect(b.last('events')?.events).toEqual([]);
  });
});

describe('clock', () => {
  it('ticks at 60 Hz without drift once started', async () => {
    const room = newRoom();
    room.start();
    const start = performance.now();
    const startTick = room.tick;
    // A longer window keeps scheduler jitter under parallel test load small next to real drift (e.g. 62.5 Hz from setInterval(16)).
    await new Promise((r) => setTimeout(r, 3000));
    const expected = ((performance.now() - start) * 60) / 1000;
    expect(Math.abs(room.tick - startTick - expected)).toBeLessThan(3);
    room.stop();
  });

  it('runs on the timers of the schedule it is started with and catches up on late ones', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const armed: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
    const room = newRoom();
    room.start((run, delayMs) => {
      const timer = { run, delayMs, cancelled: false };
      armed.push(timer);
      return () => (timer.cancelled = true);
    });
    expect(armed.map((t) => t.delayMs)).toEqual([1000 / 60]);

    now.mockReturnValue(1000 + 500);
    armed[0].run();
    expect(room.tick).toBe(30);
    expect(armed[1].delayMs).toBeCloseTo(1000 / 60);
    room.stop();
    expect(armed[1].cancelled).toBe(true);
  });
});
