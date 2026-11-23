import { createServer, type GolixServer } from '@golix/server';
import { InputFlags, Team, hashRoom, type RoomEvent } from '@golix/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { hostRoom, type HostedRoom } from '../../src/net/host.ts';
import { JoinError, NetSession } from '../../src/net/netSession.ts';
import { httpRoomList } from '../../src/net/roomList.ts';
import { joinConnect } from '../../src/net/transport.ts';

/** A peer connection whose ICE never connects, as behind a NAT that blocks direct traffic. */
function blockedPeerConnection(): RTCPeerConnection {
  const pc = {
    localDescription: null as { sdp: string } | null,
    connectionState: 'new',
    createDataChannel: () => ({ binaryType: 'blob', close() {} }),
    setLocalDescription: async () => {
      pc.localDescription = { sdp: 'v=0 blocked' };
    },
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    close() {},
  };
  return pc as unknown as RTCPeerConnection;
}

function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await cond()) resolve();
      else if (performance.now() - start > timeoutMs) reject(new Error('timed out'));
      else setTimeout(poll, 10);
    };
    void poll();
  });
}

const REQUEST = { name: 'Friday', maxPlayers: 6, public: true, country: 'tr', lat: 41, lon: 29 };
const join = (name: string, password = 'pw') => ({ name, avatar: '', country: 'tr', password, auth: name });

let server: GolixServer | null = null;
const hosted: HostedRoom[] = [];

afterEach(async () => {
  for (const h of hosted.splice(0)) h.close();
  await server?.close();
  server = null;
});

describe('browser-hosted room', () => {
  it('runs the room for its host in-process and relays a joiner whose ICE fails through the lobby', { timeout: 15_000 }, async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 0 });
    const lobby = `ws://127.0.0.1:${server.port}`;
    const h = await hostRoom({ serverUrl: lobby, request: REQUEST, password: 'pw', createPeerConnection: blockedPeerConnection });
    hosted.push(h);
    hosted.push(await hostRoom({ serverUrl: lobby, request: { ...REQUEST, name: 'Hidden', public: false }, password: '', createPeerConnection: blockedPeerConnection }));

    const host = await NetSession.join({ url: 'local', join: join('alice'), connect: h.connect });
    expect(host.path).toBe('host');
    expect(host.getRoom().players).toEqual([expect.objectContaining({ name: 'alice', admin: true })]);
    await waitFor(async () => (await httpRoomList(lobby).list())[0]?.players === 1);
    expect(await httpRoomList(lobby).list()).toEqual([{ id: h.id, name: 'Friday', players: 1, maxPlayers: 6, hasPassword: true, captcha: false, actionKeys: false, country: 'tr', lat: 41, lon: 29 }]);
    h.room.hostEvent({ type: 'setActionKeys', enabled: true });
    await waitFor(async () => (await httpRoomList(lobby).list())[0]?.actionKeys === true);

    const connect = joinConnect({ createPeerConnection: blockedPeerConnection, iceTimeoutMs: 100 });
    await expect(NetSession.join({ url: `${lobby}/room/${h.id}`, join: join('mallory', 'nope'), connect })).rejects.toEqual(new JoinError('password'));
    const bob = await NetSession.join({ url: `${lobby}/room/${h.id}`, join: join('bob'), connect });
    expect(bob.path).toBe('relay');
    await waitFor(async () => (await httpRoomList(lobby).list())[0]?.players === 2);

    const pings: [number, number][][] = [];
    host.onEvent((ev) => ev.type === 'ping' && pings.push(ev.pings));
    const chat: RoomEvent[] = [];
    host.onEvent((ev) => ev.type === 'chat' && chat.push(ev));
    host.send({ type: 'request', event: { type: 'setTeam', playerId: host.playerId, team: Team.red, byPlayer: null, announce: false } });
    host.send({ type: 'request', event: { type: 'setTeam', playerId: bob.playerId, team: Team.blue, byPlayer: null, announce: false } });
    host.send({ type: 'request', event: { type: 'startGame', byPlayer: null } });
    await waitFor(() => bob.getRoom().game !== null);
    const x0 = bob.getRoom().game!.players.find((p) => p.id === bob.playerId)!.disc!.pos.x;
    bob.sendInput(InputFlags.left);
    host.sendInput(InputFlags.right);
    bob.send({ type: 'chat', text: 'hello host' });
    await waitFor(() => chat.length > 0 && h.room.state.game!.players.find((p) => p.id === bob.playerId)!.disc!.pos.x < x0 - 30);
    expect(chat).toEqual([{ type: 'chat', playerId: bob.playerId, text: 'hello host' }]);

    await waitFor(() => pings.length > 0, 3000);
    // In-process round trips measure 0 ms, or 1 ms when the test machine is busy.
    expect(pings[0].find(([id]) => id === host.playerId)?.[1]).toBeLessThanOrEqual(1);
    h.room.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(hashRoom(bob.getRoom())).toBe(hashRoom(h.room.state));
    expect(hashRoom(host.getRoom())).toBe(hashRoom(h.room.state));
    expect(bob.sync.desyncs).toBe(0);

    const reason = new Promise<string>((resolve) => bob.onClose(resolve));
    host.leave();
    h.close();
    expect(await reason).toBe('closed');
    await waitFor(async () => (await httpRoomList(lobby).list()).length === 0);
  });

  it('comes back under the same id after a lobby restart and keeps its relayed joiner playing', { timeout: 20_000 }, async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const { port } = server;
    const lobby = `ws://127.0.0.1:${port}`;
    const h = await hostRoom({ serverUrl: lobby, request: REQUEST, password: '', createPeerConnection: blockedPeerConnection });
    hosted.push(h);
    const host = await NetSession.join({ url: 'local', join: join('alice', ''), connect: h.connect });
    const bob = await NetSession.join({ url: `${lobby}/room/${h.id}`, join: join('bob', ''), connect: joinConnect({ createPeerConnection: blockedPeerConnection, iceTimeoutMs: 100 }) });
    expect(bob.path).toBe('relay');
    const closes: string[] = [];
    bob.onClose((reason) => closes.push(reason));

    await server.close();
    server = await createServer({ port, host: '127.0.0.1' });
    await waitFor(async () => (await httpRoomList(lobby).list()).length === 1, 8000);
    expect((await httpRoomList(lobby).list())[0]).toEqual(expect.objectContaining({ id: h.id, players: 2 }));

    const chat: RoomEvent[] = [];
    host.onEvent((ev) => ev.type === 'chat' && chat.push(ev));
    bob.send({ type: 'chat', text: 'still here' });
    await waitFor(() => chat.length > 0, 5000);
    expect(chat).toEqual([{ type: 'chat', playerId: bob.playerId, text: 'still here' }]);
    h.room.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(hashRoom(bob.getRoom())).toBe(hashRoom(h.room.state));
    expect(closes).toEqual([]);
    host.leave();
  });

  it('keeps a relayed joiner through a lobby outage longer than the session silence timeout', { timeout: 30_000 }, async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const { port } = server;
    const lobby = `ws://127.0.0.1:${port}`;
    const h = await hostRoom({ serverUrl: lobby, request: REQUEST, password: '', createPeerConnection: blockedPeerConnection });
    hosted.push(h);
    const host = await NetSession.join({ url: 'local', join: join('alice', ''), connect: h.connect });
    const bob = await NetSession.join({ url: `${lobby}/room/${h.id}`, join: join('bob', ''), connect: joinConnect({ createPeerConnection: blockedPeerConnection, iceTimeoutMs: 100 }) });
    const closes: string[] = [];
    bob.onClose((reason) => closes.push(reason));

    await server.close();
    await new Promise((r) => setTimeout(r, 12_000));
    server = await createServer({ port, host: '127.0.0.1' });

    const chat: RoomEvent[] = [];
    host.onEvent((ev) => ev.type === 'chat' && chat.push(ev));
    await waitFor(async () => (await httpRoomList(lobby).list()).length === 1, 3000);
    bob.send({ type: 'chat', text: 'back' });
    await waitFor(() => chat.length > 0, 5000);
    expect(closes).toEqual([]);
    host.leave();
  });

  it('tells a relayed joiner the lobby is gone when it does not come back', { timeout: 30_000 }, async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const lobby = `ws://127.0.0.1:${server.port}`;
    const h = await hostRoom({ serverUrl: lobby, request: REQUEST, password: '', createPeerConnection: blockedPeerConnection });
    hosted.push(h);
    const bob = await NetSession.join({ url: `${lobby}/room/${h.id}`, join: join('bob', ''), connect: joinConnect({ createPeerConnection: blockedPeerConnection, iceTimeoutMs: 100 }) });
    const reason = new Promise<string>((resolve) => bob.onClose(resolve));
    await server.close();
    server = null;
    expect(await reason).toBe('lobby');
  });

  it("passes the room token to a lobby that asks for one, and its reason when the token is missing", async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', captcha: { siteKey: 'k', verify: async () => true }, roomTokens: { known: new Set<string>(), graceMs: 0 } });
    const lobby = `ws://127.0.0.1:${server.port}`;
    await expect(hostRoom({ serverUrl: lobby, request: REQUEST, password: '' })).rejects.toThrow('Opening a room needs a token from /headlesstoken');
    const { token } = (await (await fetch(`http://127.0.0.1:${server.port}/token`, { method: 'POST', body: 'solved' })).json()) as { token: string };
    const h = await hostRoom({ serverUrl: lobby, request: REQUEST, password: '', token });
    hosted.push(h);
    expect(h.id).toMatch(/^[\w-]{11}$/);
  });

  it('fails to create the room when the lobby refuses the registration', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    await expect(hostRoom({ serverUrl: `ws://127.0.0.1:${server.port}`, request: { ...REQUEST, maxPlayers: 40 }, password: '' })).rejects.toThrow('Could not create the room.');
  });
});
