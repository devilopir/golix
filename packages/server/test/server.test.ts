import { Room } from '@golix/room';
import { decodeServerMessage, encodeClientMessage, type ServerToHost, type ServerToJoiner } from '@golix/shared';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type ClientOptions, type RawData } from 'ws';
import { FakePeer, signNonce, testKey } from '../../room/test/helpers.ts';
import { createServer, type GolixServer } from '../src/index.ts';
import { parseBanList } from '../src/server.ts';

let server: GolixServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

type Frame = { text: unknown } | { bytes: Buffer };

/** A socket whose frames are read in order; text frames are parsed as JSON. */
async function open(path: string, options?: ClientOptions) {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}${path}`, options);
  const queue: Frame[] = [];
  const waiting: ((f: Frame) => void)[] = [];
  ws.on('message', (data: RawData, isBinary) => {
    const frame = isBinary ? { bytes: data as Buffer } : { text: JSON.parse(data.toString()) };
    const w = waiting.shift();
    if (w) w(frame);
    else queue.push(frame);
  });
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
  const next = () => new Promise<Frame>((resolve) => {
    const f = queue.shift();
    if (f) resolve(f);
    else waiting.push(resolve);
  });
  const text = async <T,>() => {
    const f = await next();
    if (!('text' in f)) throw new Error('expected a text frame');
    return f.text as T;
  };
  const bytes = async () => {
    const f = await next();
    if (!('bytes' in f)) throw new Error('expected a binary frame');
    return f.bytes;
  };
  const json = (msg: unknown) => ws.send(JSON.stringify(msg));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, text, bytes, json, closed };
}

/** Headers of a request Cloudflare passed on through a local proxy, as Caddy sets X-Forwarded-For to its peer. */
const viaCloudflare = (headers: Record<string, string>) => ({ 'x-forwarded-for': '173.245.48.9', ...headers });

const ROOM = { name: 'Test room', maxPlayers: 8, public: true, country: 'tr', lat: 41, lon: 29 };
const newSecret = () => randomBytes(16).toString('base64url');
const TOKEN = 'resume-token-012345678';

async function host(overrides: Partial<typeof ROOM> = {}, secret = newSecret()) {
  const h = await open('/host');
  h.json({ type: 'register', ...ROOM, ...overrides, hasPassword: false, secret });
  const registered = await h.text<ServerToHost>();
  if (registered.type !== 'registered') throw new Error(`unexpected ${registered.type}`);
  return { ...h, id: registered.id };
}

async function list(): Promise<unknown> {
  return (await fetch(`http://127.0.0.1:${server!.port}/rooms`)).json();
}

const CANDIDATE = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };

describe('lobby', () => {
  it('lists a registered room with the live counts its host reports and drops it when the host disconnects', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 0 });
    const h = await host();
    expect(h.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(await list()).toEqual([{ id: h.id, name: 'Test room', players: 0, maxPlayers: 8, hasPassword: false, captcha: false, actionKeys: false, country: 'tr', lat: 41, lon: 29 }]);
    h.json({ type: 'update', players: 3, hasPassword: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(await list()).toEqual([expect.objectContaining({ id: h.id, players: 3, hasPassword: true })]);

    const res = await fetch(`http://127.0.0.1:${server.port}/rooms`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`http://127.0.0.1:${server.port}/rooms`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${server.port}/other`)).status).toBe(404);

    const joiner = await open(`/room/${h.id}`);
    expect(await joiner.text()).toEqual({ type: 'webrtc', iceServers: [] });
    h.ws.close();
    expect(await joiner.text()).toEqual({ type: 'hostAway' });
    expect(await joiner.text()).toEqual({ type: 'hostLost' });
    await joiner.closed;
    expect(await list()).toEqual([]);
  });

  it('lists whether a room asks for a captcha and uses action keys, as its host reports', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const h = await open('/host');
    h.json({ type: 'register', ...ROOM, hasPassword: false, captcha: true, actionKeys: false, secret: newSecret() });
    await h.text();
    expect(await list()).toEqual([expect.objectContaining({ captcha: true, actionKeys: false })]);
    h.json({ type: 'update', players: 1, hasPassword: false, captcha: false, actionKeys: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(await list()).toEqual([expect.objectContaining({ captcha: false, actionKeys: true })]);
  });

  it('lists the name and player limit a host changes while it runs, even below its player count', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const h = await host();
    h.json({ type: 'update', name: 'y'.repeat(60), maxPlayers: 2, players: 3, hasPassword: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(await list()).toEqual([expect.objectContaining({ name: 'y'.repeat(40), maxPlayers: 2, players: 3 })]);
    h.json({ type: 'update', maxPlayers: 31, players: 0, hasPassword: false });
    await h.closed;
  });

  it('derives the room id from the host secret and lets a new registration with it take over a stale one and its players', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const secret = newSecret();
    const stale = await host({}, secret);
    expect(stale.id).toBe(createHash('sha256').update(secret).digest('base64url').slice(0, 11));
    const watcher = await open(`/room/${stale.id}`);
    await watcher.text();

    const fresh = await host({ name: 'Back again' }, secret);
    expect(fresh.id).toBe(stale.id);
    await stale.closed;
    expect(watcher.ws.readyState).toBe(watcher.ws.OPEN);
    expect(await list()).toEqual([expect.objectContaining({ id: fresh.id, name: 'Back again' })]);
    const joiner = await open(`/room/${fresh.id}`);
    expect(await joiner.text()).toEqual({ type: 'webrtc', iceServers: [] });
  });

  it('hands out the configured STUN servers and TURN credentials in coturn REST API form', async () => {
    const secret = 'coturn-shared-secret';
    server = await createServer({ port: 0, host: '127.0.0.1', stunUrls: ['stun:turn.example.test:3478'], turn: { urls: ['turn:turn.example.test:3478?transport=udp'], secret, ttlSeconds: 600 } });
    const h = await host();
    const joiner = await open(`/room/${h.id}`);
    const before = Math.floor(Date.now() / 1000);
    const webrtc = await joiner.text<Extract<ServerToJoiner, { type: 'webrtc' }>>();
    const [stun, turn] = webrtc.iceServers;
    expect(stun).toEqual({ urls: ['stun:turn.example.test:3478'] });
    expect(turn.urls).toEqual(['turn:turn.example.test:3478?transport=udp']);
    const [expiry, user] = turn.username!.split(':');
    expect(user).toBe('golix');
    expect(Number(expiry) - before).toBeGreaterThanOrEqual(599);
    expect(Number(expiry) - before).toBeLessThanOrEqual(601);
    expect(turn.credential).toBe(createHmac('sha1', secret).update(turn.username!).digest('base64'));

    joiner.json({ type: 'offer', sdp: 'v=0 offer' });
    const offer = await h.text<Extract<ServerToHost, { type: 'offer' }>>();
    expect(offer.iceServers).toEqual([stun, expect.objectContaining({ urls: turn.urls, username: expect.any(String), credential: expect.any(String) })]);
  });

  it('keeps a room and its data channel players through a short host outage', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 300 });
    const secret = newSecret();
    const first = await host({}, secret);
    const player = await open(`/room/${first.id}`);
    await player.text();
    first.ws.close();
    await first.closed;
    await new Promise((r) => setTimeout(r, 100));
    expect(await list()).toEqual([expect.objectContaining({ id: first.id })]);

    const back = await host({}, secret);
    expect(back.id).toBe(first.id);
    await new Promise((r) => setTimeout(r, 400));
    expect(player.ws.readyState).toBe(player.ws.OPEN);
    expect(await list()).toEqual([expect.objectContaining({ id: first.id })]);
  });

  it('tells the players the host is gone once the grace period runs out, and does not count a returning host as a new room', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 100, roomRegistrations: { limit: 1, windowMs: 60_000 } });
    const secret = newSecret();
    const first = await host({}, secret);
    first.ws.close();
    await first.closed;
    const again = await host({}, secret);
    expect(again.id).toBe(first.id);
    const player = await open(`/room/${again.id}`);
    await player.text();
    again.ws.close();
    expect(await player.text()).toEqual({ type: 'hostAway' });
    expect(await player.text()).toEqual({ type: 'hostLost' });
    await player.closed;
    expect(await list()).toEqual([]);
  });

  it('keeps private rooms unlisted and closes hosts that register badly or report impossible counts', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 0 });
    await host({ public: false });
    expect(await list()).toEqual([]);
    for (const bad of [{ ...ROOM, maxPlayers: 1 }, { ...ROOM, maxPlayers: 31 }, { ...ROOM, maxPlayers: 2.5 }, { ...ROOM, country: 'TUR' }, { ...ROOM, lat: 91 }, { ...ROOM, public: 'yes' }]) {
      const h = await open('/host');
      h.json({ type: 'register', ...bad, hasPassword: false, secret: newSecret() });
      await h.closed;
    }
    for (const bad of [{ secret: newSecret() }, { hasPassword: false }, { hasPassword: false, secret: 'short' }]) {
      const h = await open('/host');
      h.json({ type: 'register', ...ROOM, ...bad });
      await h.closed;
    }
    const named = await host({ name: 'x'.repeat(60) });
    expect(await list()).toEqual([expect.objectContaining({ id: named.id, name: 'x'.repeat(40) })]);
    named.json({ type: 'update', players: 31, hasPassword: false });
    await named.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(await list()).toEqual([]);
  });

  it('serves a room running in the process to joiners over their socket', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const room = new Room({ name: 'Local', maxPlayers: 4 });
    const id = server.addRoom(room, { ...ROOM, name: 'Local', public: true });
    room.start();
    const joiner = await open(`/room/${id}`);
    expect(await joiner.text()).toEqual({ type: 'relay' });
    const challenge = decodeServerMessage(new Uint8Array(await joiner.bytes()));
    if (challenge.type !== 'challenge') throw new Error(`unexpected ${challenge.type}`);
    joiner.ws.send(encodeClientMessage({ type: 'join', name: 'alice', avatar: '', country: 'tr', password: '', auth: testKey('alice').authId, signature: signNonce('alice', challenge.nonce), verified: '' }));
    const welcome = decodeServerMessage(new Uint8Array(await joiner.bytes()));
    if (welcome.type !== 'welcome') throw new Error(`unexpected ${welcome.type}`);
    expect(welcome.room.name).toBe('Local');
    expect(room.peerInfo(welcome.playerId)).toEqual({ auth: testKey('alice').authId, conn: Buffer.from('127.0.0.1').toString('hex').toUpperCase() });
    expect(await list()).toEqual([expect.objectContaining({ id, name: 'Local', players: 1 })]);
  });

  it('refuses unknown rooms', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    for (const path of ['/room/missing0000', '/elsewhere']) {
      const ws = await open(path);
      expect(decodeServerMessage(new Uint8Array(await ws.bytes()))).toEqual({ type: 'joinRejected', reason: 'invalid' });
    }
  });

  it('tells a visitor its Cloudflare country and the notice', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', notice: 'Maintenance at 22:00' });
    const lobby = async (headers: Record<string, string> = {}) => (await fetch(`http://127.0.0.1:${server!.port}/lobby`, { headers })).json();
    expect(await lobby(viaCloudflare({ 'cf-ipcountry': 'TR' }))).toEqual({ country: 'tr', notice: 'Maintenance at 22:00', captchaSiteKey: '' });
    expect(await lobby()).toEqual({ country: '', notice: 'Maintenance at 22:00', captchaSiteKey: '' });
    expect(await lobby({ 'cf-ipcountry': 'TR' })).toMatchObject({ country: '' });
    expect(await lobby(viaCloudflare({ 'cf-ipcountry': 'XX' }))).toMatchObject({ country: '' });
    expect(await lobby(viaCloudflare({ 'cf-ipcountry': 'T1' }))).toMatchObject({ country: '' });
    await server.close();
    server = await createServer({ port: 0, host: '127.0.0.1' });
    expect(await lobby()).toEqual({ country: '', notice: '', captchaSiteKey: '' });
  });

  it('refuses sockets over the per-address open and per-window limits before the upgrade', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', connections: { open: 2, limit: 3, windowMs: 300 } });
    const connect = (ip: string) =>
      new Promise<WebSocket | string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/host`, { headers: viaCloudflare({ 'cf-connecting-ip': ip }) });
        ws.once('open', () => resolve(ws));
        ws.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      });
    const a = await connect('192.0.2.1');
    const b = await connect('192.0.2.1');
    expect(await connect('192.0.2.1')).toBe('429');
    expect(await connect('192.0.2.2')).toBeInstanceOf(WebSocket);
    (a as WebSocket).close();
    await new Promise((r) => (a as WebSocket).once('close', r));
    await new Promise((r) => setTimeout(r, 20));
    const c = await connect('192.0.2.1');
    expect(c).toBeInstanceOf(WebSocket);
    (c as WebSocket).close();
    await new Promise((r) => (c as WebSocket).once('close', r));
    await new Promise((r) => setTimeout(r, 20));
    expect(await connect('192.0.2.1')).toBe('429');
    await new Promise((r) => setTimeout(r, 320));
    expect(await connect('192.0.2.1')).toBeInstanceOf(WebSocket);
    (b as WebSocket).close();
  });

  it('logs checked connection reports with the visitor country, refuses malformed ones and limits each address', async () => {
    const reports: unknown[] = [];
    server = await createServer({ port: 0, host: '127.0.0.1', telemetry: (r) => reports.push(r) });
    const post = async (body: string, headers: Record<string, string> = {}) =>
      (await fetch(`http://127.0.0.1:${server!.port}/telemetry`, { method: 'POST', body, headers })).status;
    const report = { v: 1, path: 'relay', seconds: 90, ping: { n: 40, p50: 31, p95: 48, max: 120 }, inputDelay: null, stalls: 2, desyncs: 0, extrapolation: 0, name: 'dropped' };
    expect(await post(JSON.stringify(report), viaCloudflare({ 'cf-ipcountry': 'TR' }))).toBe(204);
    expect(reports).toEqual([{ path: 'relay', seconds: 90, ping: { n: 40, p50: 31, p95: 48, max: 120 }, inputDelay: null, stalls: 2, desyncs: 0, extrapolation: 0, country: 'tr' }]);
    expect(await post('{ not json')).toBe(400);
    expect(await post(JSON.stringify({ ...report, path: 'host' }))).toBe(400);
    expect(await post(JSON.stringify({ ...report, stalls: -1 }))).toBe(400);
    expect(await post(JSON.stringify({ ...report, ping: { n: 1, p50: 'x', p95: 1, max: 1 } }))).toBe(400);
    expect(await post('x'.repeat(5000)).catch(() => 'cut off')).toBe('cut off');
    expect(await post(JSON.stringify(report))).toBe(204);
    expect(await post(JSON.stringify(report))).toBe(429);
    expect(reports).toHaveLength(2);
  });

  it('limits how many rooms one address registers per window', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', roomRegistrations: { limit: 2, windowMs: 300 } });
    const register = async (ip: string) => {
      const h = await open('/host', { headers: viaCloudflare({ 'cf-connecting-ip': ip }) });
      h.json({ type: 'register', ...ROOM, hasPassword: false, secret: newSecret() });
      const reply = await Promise.race([h.text<ServerToHost>(), new Promise<number>((resolve) => h.ws.once('close', resolve))]);
      return typeof reply === 'number' ? reply : reply.type;
    };
    expect(await register('192.0.2.1')).toBe('registered');
    expect(await register('192.0.2.1')).toBe('registered');
    expect(await register('192.0.2.1')).toBe(1008);
    expect(await register('192.0.2.2')).toBe('registered');
    await new Promise((r) => setTimeout(r, 350));
    expect(await register('192.0.2.1')).toBe('registered');
  });

  it('does not count a host registering its room again after the grace period against the limit', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 0, roomRegistrations: { limit: 1, windowMs: 60_000 } });
    const secret = newSecret();
    const first = await host({}, secret);
    first.ws.close();
    await first.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(await list()).toEqual([]);
    expect((await host({}, secret)).id).toBe(first.id);
    const other = await open('/host');
    const code = new Promise((resolve) => other.ws.once('close', resolve));
    other.json({ type: 'register', ...ROOM, hasPassword: false, secret: newSecret() });
    expect(await code).toBe(1008);
  });

  it('terminates sockets that stop answering pings', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', heartbeatMs: 50, hostGraceMs: 0 });
    const h = await open('/host', { autoPong: false });
    h.json({ type: 'register', ...ROOM, hasPassword: false, secret: newSecret() });
    await h.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(await list()).toEqual([]);
  });
});

describe('signaling', () => {
  it('checks a captcha token during the upgrade and tells the host which joiners solved one', async () => {
    const checked: [string, string][] = [];
    const captcha = { siteKey: 'site-key', verify: async (token: string, ip: string) => (checked.push([token, ip]), token === 'good') };
    server = await createServer({ port: 0, host: '127.0.0.1', captcha });
    expect(await (await fetch(`http://127.0.0.1:${server.port}/lobby`)).json()).toEqual(expect.objectContaining({ captchaSiteKey: 'site-key' }));
    const h = await open('/host');
    h.json({ type: 'register', ...ROOM, hasPassword: false, secret: newSecret() });
    const registered = await h.text<Extract<ServerToHost, { type: 'registered' }>>();
    expect(registered.captcha).toBe(true);
    const offerWith = async (query: string) => {
      const joiner = await open(`/room/${registered.id}${query}`);
      await joiner.text();
      joiner.json({ type: 'offer', sdp: 'v=0 offer' });
      return (await h.text<Extract<ServerToHost, { type: 'offer' }>>()).captcha;
    };
    expect(await offerWith('?captcha=good')).toBe(true);
    expect(await offerWith('?captcha=bad')).toBe(false);
    expect(await offerWith('')).toBe(false);
    expect(checked).toEqual([
      ['good', '127.0.0.1'],
      ['bad', '127.0.0.1'],
    ]);
  });

  it("gives a joiner who solved the captcha a proof for its auth that lets the same key into a room asking for a captcha", async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', captcha: { siteKey: 'k', verify: async (token) => token === 'good' } });
    const h = await host();
    const proofFor = async (query: string) => {
      const joiner = await open(`/room/${h.id}${query}`);
      const first = await joiner.text<ServerToJoiner>();
      return first.type === 'verified' ? first.value : null;
    };
    expect(await proofFor('?captcha=bad&auth=' + testKey('alice').authId)).toBeNull();
    expect(await proofFor('')).toBeNull();
    const proof = await proofFor('?captcha=good&auth=' + testKey('alice').authId);
    expect(proof).toMatch(/^\d+\.[\w-]+$/);

    const room = new Room({ name: 'r', maxPlayers: 4 });
    room.setVerifyKey(Buffer.from(server.verifyKey, 'base64url'));
    room.setCaptchaAvailable(true);
    room.setRequireCaptcha(true);
    const alice = new FakePeer(room, 'AA');
    alice.join('alice', { verified: proof! });
    const bob = new FakePeer(room, 'BB');
    bob.join('bob', { verified: proof! });
    room.runTick();
    expect(alice.last('welcome')).toBeDefined();
    expect(bob.received[0]).toEqual({ type: 'joinRejected', reason: 'captcha' });
  });

  it("sends its ban list to hosts when they register and when it changes, and gives a banned auth no captcha proof", async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', captcha: { siteKey: 'k', verify: async () => true } });
    server.setBans([testKey('mallory').authId]);
    const h = await open('/host');
    h.json({ type: 'register', ...ROOM, hasPassword: false, secret: newSecret() });
    const registered = await h.text<Extract<ServerToHost, { type: 'registered' }>>();
    expect(await h.text()).toEqual({ type: 'bans', auths: [testKey('mallory').authId] });
    server.setBans([]);
    expect(await h.text()).toEqual({ type: 'bans', auths: [] });
    server.setBans([testKey('mallory').authId]);
    await h.text();
    const joiner = await open(`/room/${registered.id}?captcha=ok&auth=${testKey('mallory').authId}`);
    expect(await joiner.text()).toEqual(expect.objectContaining({ type: 'webrtc' }));
  });

  it('reads a ban list of one auth per line with comments, skipping anything else', () => {
    const auth = testKey('mallory').authId;
    expect(parseBanList(`# raiders\n${auth}  # spammed 3 rooms\n\nnot-an-auth\n  ${testKey('eve').authId}\n`)).toEqual([auth, testKey('eve').authId]);
  });

  it('asks a new room for a single-use token bought with a captcha, and lets a known room back without one', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 0, captcha: { siteKey: 'k', verify: async (t) => t === 'solved' }, roomTokens: { known: new Set<string>(), graceMs: 0 } });
    const register = async (secret: string, token?: string) => {
      const h = await open('/host');
      h.json({ type: 'register', ...ROOM, hasPassword: false, secret, token });
      const reply = await Promise.race([h.text<ServerToHost>(), new Promise<string>((resolve) => h.ws.once('close', (_code, reason) => resolve(reason.toString())))]);
      return { h, reply: typeof reply === 'string' ? reply : reply.type };
    };
    const buy = async (captcha: string) => {
      const res = await fetch(`http://127.0.0.1:${server!.port}/token`, { method: 'POST', body: captcha });
      return res.ok ? ((await res.json()) as { token: string }).token : res.status;
    };
    const secret = newSecret();
    expect((await register(secret)).reply).toBe('Opening a room needs a token from /headlesstoken');
    expect(await buy('wrong')).toBe(403);
    const token = (await buy('solved')) as string;
    expect((await register(secret, `${token}x`)).reply).toMatch(/token/);
    const first = await register(secret, token);
    expect(first.reply).toBe('registered');
    expect((await register(newSecret(), token)).reply).toMatch(/token/);
    first.h.ws.close();
    await first.h.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect((await register(secret)).reply).toBe('registered');
  });

  it('drops the IPv4-mapped prefix from a dual-stack socket address', async () => {
    server = await createServer({ port: 0, host: '::' });
    const h = await host();
    const joiner = await open(`/room/${h.id}`);
    await joiner.text();
    joiner.json({ type: 'offer', sdp: 'v=0 offer' });
    expect(await h.text()).toEqual(expect.objectContaining({ type: 'offer', conn: Buffer.from('127.0.0.1').toString('hex').toUpperCase() }));
  });

  it("gives the host the joiner's address from Cloudflare's header, not the proxy's", async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const h = await host();
    const joiner = await open(`/room/${h.id}`, { headers: viaCloudflare({ 'cf-connecting-ip': '198.51.100.7' }) });
    await joiner.text();
    joiner.json({ type: 'offer', sdp: 'v=0 offer' });
    expect(await h.text()).toEqual(expect.objectContaining({ type: 'offer', conn: Buffer.from('198.51.100.7').toString('hex').toUpperCase() }));
  });

  it("ignores Cloudflare's header from anyone but Cloudflare, so a direct visitor cannot pick its address", async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const h = await host();
    const conn = async (headers: Record<string, string>) => {
      const joiner = await open(`/room/${h.id}`, { headers });
      await joiner.text();
      joiner.json({ type: 'offer', sdp: 'v=0 offer' });
      return Buffer.from((await h.text<Extract<ServerToHost, { type: 'offer' }>>()).conn, 'hex').toString();
    };
    expect(await conn({ 'x-forwarded-for': '203.0.113.5', 'cf-connecting-ip': '198.51.100.7' })).toBe('203.0.113.5');
    expect(await conn({ 'x-forwarded-for': '1.2.3.4, 203.0.113.5' })).toBe('203.0.113.5');
    expect(await conn({ 'cf-connecting-ip': '198.51.100.7' })).toBe('127.0.0.1');
  });

  it('tells a joiner on a data channel at once when the host drops, before the grace period ends', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 60_000 });
    const h = await host();
    const joiner = await open(`/room/${h.id}`);
    await joiner.text();
    joiner.json({ type: 'offer', sdp: 'v=0 offer' });
    await h.text();
    h.ws.close();
    expect(await joiner.text()).toEqual({ type: 'hostAway' });
  });

  it('relays the offer, answer and ICE candidates between a joiner and the host', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const h = await host();
    const joiner = await open(`/room/${h.id}`);
    expect(await joiner.text()).toEqual({ type: 'webrtc', iceServers: [] });

    joiner.json({ type: 'candidate', candidate: CANDIDATE });
    joiner.json({ type: 'offer', sdp: 'v=0 offer' });
    const offer = await h.text<Extract<ServerToHost, { type: 'offer' }>>();
    expect(offer).toEqual({ type: 'offer', peer: expect.any(Number), conn: Buffer.from('127.0.0.1').toString('hex').toUpperCase(), captcha: false, sdp: 'v=0 offer', iceServers: [] });
    joiner.json({ type: 'candidate', candidate: { ...CANDIDATE, extra: 'dropped' } });
    expect(await h.text()).toEqual({ type: 'candidate', peer: offer.peer, candidate: CANDIDATE });
    joiner.json({ type: 'candidate', candidate: { candidate: 7 } });

    h.json({ type: 'answer', peer: offer.peer, sdp: 'v=0 answer' });
    h.json({ type: 'candidate', peer: offer.peer, candidate: CANDIDATE });
    h.json({ type: 'answer', peer: offer.peer + 100, sdp: 'v=0 lost' });
    expect(await joiner.text<ServerToJoiner>()).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    expect(await joiner.text<ServerToJoiner>()).toEqual({ type: 'candidate', candidate: CANDIDATE });

    joiner.ws.close();
    expect(await h.text()).toEqual({ type: 'leave', peer: offer.peer });
  });

  it('relays game bytes through the server once a joiner asks for it', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const h = await host();
    const joiner = await open(`/room/${h.id}`);
    await joiner.text();
    joiner.json({ type: 'relay', token: TOKEN });
    const relay = await h.text<Extract<ServerToHost, { type: 'relay' }>>();
    expect(relay).toEqual({ type: 'relay', peer: expect.any(Number), conn: expect.any(String), captcha: false, token: TOKEN });

    joiner.ws.send(Uint8Array.of(1, 2, 3));
    const up = await h.bytes();
    expect(up.readUInt32BE(0)).toBe(relay.peer);
    expect([...up.subarray(4)]).toEqual([1, 2, 3]);

    const down = Buffer.alloc(6);
    down.writeUInt32BE(relay.peer, 0);
    down.set([4, 5], 4);
    h.ws.send(down);
    expect([...(await joiner.bytes())]).toEqual([4, 5]);

    joiner.json({ type: 'offer', sdp: 'too late' });
    await joiner.closed;
    expect(await h.text()).toEqual({ type: 'leave', peer: relay.peer });

    const second = await open(`/room/${h.id}`);
    await second.text();
    second.json({ type: 'relay', token: TOKEN });
    const { peer } = await h.text<Extract<ServerToHost, { type: 'relay' }>>();
    h.json({ type: 'close', peer });
    await second.closed;
  });

  it('closes a joiner that asks for the relay without a resume token', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const h = await host();
    const joiner = await open(`/room/${h.id}`);
    await joiner.text();
    joiner.json({ type: 'relay', token: 'x' });
    await joiner.closed;
  });

  it('closes a joiner that sends game bytes before choosing the relay', async () => {
    server = await createServer({ port: 0, host: '127.0.0.1' });
    const h = await host();
    const joiner = await open(`/room/${h.id}`);
    await joiner.text();
    joiner.ws.send(Uint8Array.of(1));
    await joiner.closed;
  });
});
