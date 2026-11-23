import { createServer, type GolixServer } from '@golix/server';
import { InputFlags, Team, type RoomListing } from '@golix/shared';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetSession } from '../../client/src/net/netSession.ts';
import { joinConnect, type Connect } from '../../client/src/net/transport.ts';
import { signNonce, testKey } from '../../room/test/helpers.ts';
import { HBInit, JoinError, joinRoom, type PlayerObject, type RoomObject } from '../src/index.ts';

const servers: GolixServer[] = [];
const sessions: NetSession[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) s.leave();
  for (const s of servers.splice(0)) await s.close();
  vi.restoreAllMocks();
});

async function lobby(port = 0): Promise<{ server: GolixServer; url: string }> {
  const server = await createServer({ port, host: '127.0.0.1' });
  servers.push(server);
  return { server, url: `ws://127.0.0.1:${server.port}` };
}

async function rooms(url: string): Promise<RoomListing[]> {
  return (await fetch(`${url.replace(/^ws/, 'http')}/rooms`)).json() as Promise<RoomListing[]>;
}

function nextLink(room: RoomObject): Promise<string> {
  return new Promise((resolve) => (room.onRoomLink = resolve));
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

async function joinAs(url: string, id: string, name: string, connect: Connect): Promise<NetSession> {
  const session = await NetSession.join({
    url: `${url}/room/${id}`,
    join: { name, avatar: '', country: 'tr', password: '', auth: testKey(name).authId },
    sign: async (nonce) => signNonce(name, nonce),
    connect,
  });
  sessions.push(session);
  return session;
}

/** An admin room like examples/admin-room.ts. */
function adminRoom(url: string, admins: string[]): { room: RoomObject; joins: PlayerObject[] } {
  const room = HBInit({ roomName: 'Istanbul', maxPlayers: 8, noPlayer: true, geo: { code: 'TR', lat: 41, lon: 29 }, lobby: url });
  const joins: PlayerObject[] = [];
  room.onPlayerJoin = (player) => {
    joins.push(player);
    if (admins.includes(player.name)) room.setPlayerAdmin(player.id, true);
  };
  return { room, joins };
}

const nodePeerConnection = (config: RTCConfiguration) => new RTCPeerConnection(config) as unknown as globalThis.RTCPeerConnection;

describe('headless room on a remote lobby', () => {
  it('registers as a host and serves a joiner through the lobby relay', { timeout: 15_000 }, async () => {
    const { url } = await lobby();
    const { room, joins } = adminRoom(url, ['boss']);
    const link = new URL(await nextLink(room));
    const id = link.searchParams.get('c')!;
    expect(link.origin + link.pathname).toBe(`${url.replace(/^ws/, 'http')}/play`);
    expect(await rooms(url)).toEqual([{ id, name: 'Istanbul', players: 0, maxPlayers: 8, hasPassword: false, captcha: false, actionKeys: false, country: 'tr', lat: 41, lon: 29 }]);
    room.setActionKeys(true);
    await waitFor(async () => (await rooms(url))[0]?.actionKeys === true);

    // Without a usable peer connection the joiner falls back to the relay.
    const boss = await joinAs(url, id, 'boss', joinConnect({ createPeerConnection: () => { throw new Error('no WebRTC'); } }));
    expect(boss.path).toBe('relay');
    expect(joins).toEqual([expect.objectContaining({ name: 'boss', auth: testKey('boss').authId })]);
    await waitFor(() => boss.getRoom().players.find((p) => p.id === boss.playerId)?.admin === true);
    await waitFor(async () => (await rooms(url))[0]?.players === 1);

    boss.send({ type: 'request', event: { type: 'setTeam', playerId: boss.playerId, team: Team.red, byPlayer: null, announce: false } });
    boss.send({ type: 'request', event: { type: 'startGame', byPlayer: null } });
    await waitFor(() => room.getPlayerDiscProperties(boss.playerId) !== null);
    const x0 = room.getPlayerDiscProperties(boss.playerId)!.x;
    boss.sendInput(InputFlags.right);
    await waitFor(() => room.getPlayerDiscProperties(boss.playerId)!.x > x0 + 30);
    expect(boss.sync.desyncs).toBe(0);

    const guest = await joinAs(url, id, 'guest', joinConnect({ createPeerConnection: () => { throw new Error('no WebRTC'); } }));
    await waitFor(() => guest.getRoom().players.length === 2);
    expect(guest.getRoom().players.find((p) => p.id === guest.playerId)?.admin).toBe(false);
  });

  it('connects a Node joiner to the Node host over a WebRTC data channel', { timeout: 15_000 }, async () => {
    const { url } = await lobby();
    const { room } = adminRoom(url, []);
    const id = new URL(await nextLink(room)).searchParams.get('c')!;
    const chats: string[] = [];
    room.onPlayerChat = (_player, message) => void chats.push(message);

    const ana = await joinAs(url, id, 'ana', joinConnect({ createPeerConnection: nodePeerConnection }));
    expect(ana.path).toBe('p2p');
    ana.send({ type: 'chat', text: 'merhaba' });
    await waitFor(() => chats.length > 0);
    expect(chats).toEqual(['merhaba']);
  });

  it('lets a Node script join from a room link as a player and come back with the same auth', { timeout: 15_000 }, async () => {
    const { url } = await lobby();
    const room = HBInit({ roomName: 'Bots welcome', noPlayer: true, lobby: url });
    const link = await nextLink(room);
    const joins: PlayerObject[] = [];
    const chats: string[] = [];
    room.onPlayerJoin = (player) => void joins.push(player);
    room.onPlayerChat = (_player, message) => void chats.push(message);

    const bot = await joinRoom({ room: link, name: 'trainer' });
    sessions.push(bot.session);
    expect(bot.session.path).toBe('p2p');
    bot.session.send({ type: 'chat', text: 'ready' });
    await waitFor(() => chats.length > 0);
    expect(chats).toEqual(['ready']);
    bot.session.leave();

    const again = await joinRoom({ room: new URL(link).searchParams.get('c')!, lobby: url, name: 'trainer', key: bot.key });
    sessions.push(again.session);
    expect(again.auth).toBe(bot.auth);
    await waitFor(() => joins.length === 2);
    expect(joins.map((p) => p.auth)).toEqual([bot.auth, bot.auth]);
    await expect(joinRoom({ room: 'https://example.test/play', name: 'x' })).rejects.toBeInstanceOf(JoinError);
  });

  it('binds its WebRTC side to the address and port range it is given', { timeout: 15_000 }, async () => {
    const { url } = await lobby();
    const room = HBInit({ roomName: 'Bound', noPlayer: true, lobby: url, webrtc: { bindAddress: '127.0.0.1', portRange: [50110, 50119] } });
    const id = new URL(await nextLink(room)).searchParams.get('c')!;
    let joinerPc: RTCPeerConnection | null = null;
    const ana = await joinAs(url, id, 'ana', joinConnect({ createPeerConnection: (c) => (joinerPc = new RTCPeerConnection(c)) as unknown as globalThis.RTCPeerConnection }));
    expect(ana.path).toBe('p2p');
    const remote = joinerPc!.selectedCandidatePair()!.remote;
    expect(remote.address).toBe('127.0.0.1');
    expect(remote.port).toBeGreaterThanOrEqual(50110);
    expect(remote.port).toBeLessThanOrEqual(50119);
  });

  it('registers again under the same id after the lobby restarts', { timeout: 15_000 }, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await lobby();
    const { room } = adminRoom(first.url, []);
    const id = new URL(await nextLink(room)).searchParams.get('c');
    const lobbyEvents: string[] = [];
    room.onLobbyDisconnect = (retryInMs) => lobbyEvents.push(`lost, retry in ${retryInMs}`);
    room.onLobbyReconnect = () => lobbyEvents.push('back');
    const port = first.server.port;
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    await waitFor(() => warn.mock.calls.some(([msg]) => msg === `Lost the lobby at ${first.url}, reconnecting in 1 s`));

    const second = await lobby(port);
    await waitFor(async () => (await rooms(second.url)).length > 0, 8000);
    expect((await rooms(second.url)).map((r) => r.id)).toEqual([id]);
    expect(lobbyEvents[0]).toBe('lost, retry in 1000');
    expect(lobbyEvents.at(-1)).toBe('back');
    expect(lobbyEvents.filter((e) => e === 'back')).toHaveLength(1);
  });

  it('keeps the room id across restarts of the hosting process when given a room secret', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { url } = await lobby();
    const roomSecret = 'AbCdEfGhIjKlMnOpQrStUv';
    const idOf = async () => new URL(await nextLink(HBInit({ roomName: 'Fixed', noPlayer: true, lobby: url, roomSecret }))).searchParams.get('c');
    const first = await idOf();
    expect(await idOf()).toBe(first);
  });

  it('keeps retrying until the lobby is up', { timeout: 15_000 }, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = await lobby();
    const { port } = probe.server;
    await probe.server.close();
    servers.splice(servers.indexOf(probe.server), 1);
    const { room } = adminRoom(probe.url, []);
    const link = nextLink(room);
    await waitFor(() => warn.mock.calls.some(([msg]) => msg === `Could not register with the lobby at ${probe.url} (Could not create the room.), retrying in 1 s`));

    const { url } = await lobby(port);
    const id = new URL(await link).searchParams.get('c');
    expect((await rooms(url)).map((r) => r.id)).toEqual([id]);
  });
});
