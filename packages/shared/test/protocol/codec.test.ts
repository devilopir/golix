import { describe, expect, it } from 'vitest';
import { applyEvent, hashRoom, stepRoom } from '../../src/game/index.ts';
import { LIMITS, ProtocolError, decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage } from '../../src/protocol/index.ts';
import { defaultStadiums } from '../../src/stadiums/index.ts';
import { CollisionFlags, InputFlags, Team, type ClientMessage, type RoomEvent, type ServerMessage } from '../../src/types.ts';
import { join, newRoom, props, send } from '../game/helpers.ts';

const player = { id: 7, name: 'Ğüşçö İı 😀', team: Team.blue, admin: true, avatar: '😀a', country: 'tr', joinSeq: 3, ping: 87 };

const events: RoomEvent[] = [
  { type: 'input', playerId: 1, input: InputFlags.up | InputFlags.kick },
  { type: 'playerJoin', player },
  { type: 'playerLeave', playerId: 4, kicked: true, ban: true, reason: 'spam', byPlayer: 0 },
  { type: 'playerLeave', playerId: 4, kicked: false, ban: false, reason: '', byPlayer: null },
  { type: 'chat', playerId: 2, text: 'x'.repeat(LIMITS.chat) },
  { type: 'announcement', text: 'hello', targetId: null, color: 0xff00ff, style: 'small-italic', sound: 2 },
  { type: 'announcement', text: 'y'.repeat(LIMITS.announcement), targetId: 3, color: -1, style: 'normal', sound: 0 },
  { type: 'setTeam', playerId: 2, team: Team.red, byPlayer: 1, announce: false },
  { type: 'setTeam', playerId: 3, team: Team.blue, byPlayer: 1, announce: true },
  { type: 'setAdmin', playerId: 2, admin: false, byPlayer: null },
  { type: 'setAvatar', playerId: 2, avatar: 'AB' },
  { type: 'reorderPlayers', playerIds: [3, 1, 2], moveToTop: true },
  { type: 'startGame', byPlayer: 1 },
  { type: 'stopGame', byPlayer: null },
  { type: 'setPaused', paused: true, byPlayer: 5 },
  { type: 'setStadium', source: defaultStadiums[3].source, byPlayer: 1 },
  { type: 'setScoreLimit', value: 14, byPlayer: 1 },
  { type: 'setTimeLimit', value: 0, byPlayer: null },
  { type: 'setTeamsLock', locked: true, byPlayer: 1 },
  { type: 'setTeamColors', team: Team.blue, colors: { angle: 60, textColor: 0xffffff, colors: [0xff0000, 0x00ff00, 0x0000ff] }, byPlayer: 1 },
  { type: 'setKickRateLimit', limit: { min: 2, rate: 15, burst: 3 }, byPlayer: 1 },
  { type: 'setDiscProperties', discIndex: 0, props: props({ x: 0.1 + 0.2, yspeed: -3.5, color: -1, cMask: CollisionFlags.c3 | CollisionFlags.ball }) },
  { type: 'setDiscProperties', discIndex: 2, props: props({}) },
  { type: 'setPlayerDiscProperties', playerId: 9, props: props({ radius: 20, bCoeff: 0.75, invMass: 0, damping: 1, xgravity: 0.01, ygravity: Infinity, xspeed: Number.MIN_VALUE, y: -0, cGroup: CollisionFlags.c0 }) },
  { type: 'setPassword', hasPassword: true, byPlayer: 2 },
  { type: 'setTyping', playerId: 3, typing: true },
  { type: 'ping', pings: [[1, 30], [2, 0], [70000, 1234567]] },
  { type: 'syncChange', playerId: 3, synced: false },
  { type: 'syncChange', playerId: 3, synced: true },
  { type: 'setPlayerColors', playerId: 2, colors: { angle: 90, textColor: 0x000000, colors: [1, 2, 3, 4, 5] } },
  { type: 'setPlayerColors', playerId: 2, colors: null },
  { type: 'setActionKeys', enabled: true },
  { type: 'playerJoin', player: { ...player, colors: { angle: 0, textColor: 0xffffff, colors: [0x123456] } } },
  { type: 'input', playerId: 1, input: 1024 | InputFlags.kick },
];

const clientMessages: ClientMessage[] = [
  { type: 'join', name: 'n'.repeat(LIMITS.name), avatar: 'AB', country: 'tr', password: 'p'.repeat(LIMITS.password), auth: 'auth-key', signature: 's'.repeat(LIMITS.auth), verified: '' },
  { type: 'input', tick: 0xffffffff, input: 31 },
  ...events.map((event): ClientMessage => ({ type: 'request', event })),
  { type: 'chat', text: 'merhaba @dünya' },
  { type: 'pong', t: 12345.678 },
  { type: 'setPassword', password: 'şifre' },
  { type: 'setPassword', password: null },
  { type: 'clearBans' },
  { type: 'resync' },
];

function midMatchRoom() {
  const room = newRoom();
  join(room, 1, Team.red);
  join(room, 2, Team.blue);
  join(room, 3);
  send(room, [
    { type: 'setKickRateLimit', limit: { min: 2, rate: 15, burst: 3 }, byPlayer: null },
    { type: 'startGame', byPlayer: null },
    { type: 'input', playerId: 1, input: InputFlags.right | InputFlags.kick },
    { type: 'input', playerId: 2, input: InputFlags.left | InputFlags.up },
  ]);
  for (let i = 0; i < 400; i++) {
    if (i === 200) applyEvent(room, { type: 'input', playerId: 2, input: InputFlags.left | InputFlags.kick });
    stepRoom(room);
  }
  return room;
}

describe('protocol', () => {
  it.each(clientMessages.map((m) => [m.type === 'request' ? `request ${m.event.type}` : m.type, m]))('round-trips client %s', (_, msg) => {
    expect(decodeClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('round-trips every server message variant', () => {
    const room = midMatchRoom();
    const messages: ServerMessage[] = [
      { type: 'challenge', nonce: 'n'.repeat(43) },
      { type: 'welcome', playerId: 3, tick: 400, room: newRoom() },
      { type: 'welcome', playerId: 3, tick: 400, room: { ...newRoom(), actionKeys: true, players: [{ ...player, colors: { angle: 45, textColor: 0, colors: [7, 8] } }] } },
      ...(['password', 'full', 'banned', 'invalid'] as const).map((reason): ServerMessage => ({ type: 'joinRejected', reason })),
      { type: 'events', tick: 401, events },
      { type: 'events', tick: 402, events: [] },
      { type: 'hash', tick: 420, hash: 0xdeadbeef },
      { type: 'snapshot', tick: 400, room },
      { type: 'ping', t: 99.5 },
      { type: 'disconnected', reason: 'kicked' },
    ];
    for (const msg of messages) expect(decodeServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('carries a mid-match snapshot bit-exactly, sharing the parsed stadium', () => {
    const room = midMatchRoom();
    expect(room.game?.phase).not.toBe('kickoff');
    const decoded = decodeServerMessage(encodeServerMessage({ type: 'snapshot', tick: 400, room }));
    if (decoded.type !== 'snapshot') throw new Error('wrong type');
    expect(hashRoom(decoded.room)).toBe(hashRoom(room));
    expect(decoded.room.game?.stadium).toBe(room.game?.stadium);
    for (let i = 0; i < 300; i++) {
      stepRoom(room);
      stepRoom(decoded.room);
    }
    expect(hashRoom(decoded.room)).toBe(hashRoom(room));
  });

  it('enforces string limits on both ends', () => {
    expect(() => encodeClientMessage({ type: 'chat', text: 'x'.repeat(LIMITS.chat + 1) })).toThrow(ProtocolError);
    const ok = encodeClientMessage({ type: 'chat', text: 'x'.repeat(LIMITS.chat) });
    const long = new Uint8Array(ok.length + 1);
    long.set(ok);
    long[1] = LIMITS.chat + 1;
    long[2] = 1;
    long.fill(0x78, 3);
    expect(() => decodeClientMessage(long)).toThrow(ProtocolError);
    expect(() => encodeClientMessage({ type: 'join', name: 'n'.repeat(26), avatar: '', country: '', password: '', auth: '', signature: '', verified: '' })).toThrow(ProtocolError);
    expect(() => encodeClientMessage({ type: 'request', event: { type: 'setAvatar', playerId: 1, avatar: 'ABC' } })).toThrow(ProtocolError);
  });

  it('allows five stripe colors and refuses a sixth', () => {
    const kit = (n: number) => ({ angle: 0, textColor: 0, colors: Array.from({ length: n }, (_, i) => i) });
    const msg = (n: number): ServerMessage => ({ type: 'events', tick: 1, events: [{ type: 'setTeamColors', team: Team.red, colors: kit(n), byPlayer: null }] });
    expect(decodeServerMessage(encodeServerMessage(msg(5)))).toEqual(msg(5));
    expect(() => encodeServerMessage(msg(6))).toThrow('at most 5 team colors');
  });

  it('rejects malformed messages', () => {
    const msg = encodeServerMessage({ type: 'events', tick: 5, events });
    expect(() => decodeServerMessage(msg.subarray(0, msg.length - 1))).toThrow(ProtocolError);
    expect(() => decodeServerMessage(new Uint8Array([...msg, 0]))).toThrow(ProtocolError);
    expect(() => decodeClientMessage(new Uint8Array([200]))).toThrow(ProtocolError);
    expect(() => decodeClientMessage(new Uint8Array([2, 5, 1, 7]))).toThrow(ProtocolError);
    expect(() => decodeServerMessage(new Uint8Array([2, 1, 0xff, 0xff, 0xff, 0xff, 0x7f]))).toThrow(ProtocolError);
  });

  it('accepts an ArrayBuffer as well as a byte view', () => {
    const bytes = encodeServerMessage({ type: 'hash', tick: 60, hash: 1 });
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 2);
    expect(decodeServerMessage(padded.subarray(2, 2 + bytes.length))).toEqual({ type: 'hash', tick: 60, hash: 1 });
    expect(decodeServerMessage(bytes.slice().buffer)).toEqual({ type: 'hash', tick: 60, hash: 1 });
  });
});
