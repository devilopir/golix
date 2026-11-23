import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign, verify as verifySignature, type KeyObject } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { Room } from '@golix/room';
import { HOST_AWAY_CLOSE, LIMITS, MAX_MESSAGE_BYTES, encodeServerMessage, verifiedMessage, type CreateRoomRequest, type IceCandidate, type IceServer, type LobbyInfo, type RoomListing, type ServerToHost, type ServerToJoiner } from '@golix/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  /** How often silent sockets are probed; one missed probe closes them. */
  heartbeatMs?: number;
  /** How long a room whose host lost its control socket stays listed, with its players kept, waiting for the host to come back. */
  hostGraceMs?: number;
  /** Shown above the room list; empty hides it. */
  notice?: string;
  /** How many rooms one address may register within a sliding window. */
  roomRegistrations?: { limit?: number; windowMs?: number };
  /** Receives each connection report a player's client posts to /telemetry, checked and with the visitor's country; defaults to a JSON line on stdout. */
  telemetry?: (report: NetReport) => void;
  /** How many sockets one address may hold open, and open within a sliding window; refused before the upgrade. */
  connections?: { open?: number; limit?: number; windowMs?: number };
  stunUrls?: string[];
  turn?: TurnOptions;
  /** Lets rooms ask joiners for a captcha, which they solve before connecting and pass as ?captcha=<token>. */
  captcha?: CaptchaOptions;
  /**
   * Makes a room's first registration carry a room token, which POST /token hands out for a solved captcha; needs `captcha`.
   * `known` remembers the room ids that did, so a room coming back with its secret needs none; keep it across restarts.
   * For `graceMs` after the lobby starts (default a minute) rooms register without one, as running rooms come back.
   */
  roomTokens?: { known: { has(id: string): boolean; add(id: string): void }; graceMs?: number };
  /** P-256 private key that signs verified identities; keep it across restarts or players solve the captcha again. A new one otherwise. */
  identityKey?: KeyObject;
}

export interface CaptchaOptions {
  /** Public key the client renders the widget with. */
  siteKey: string;
  /** Checks a token once with the captcha provider; false when it is invalid or the check fails. */
  verify(token: string, ip: string): Promise<boolean>;
}

/** A TURN server using coturn's use-auth-secret scheme (TURN REST API credentials). */
export interface TurnOptions {
  urls: string[];
  /** coturn's static-auth-secret. */
  secret: string;
  /** How long each handed-out credential stays valid; coturn refuses to refresh an allocation after that. */
  ttlSeconds: number;
}

export interface GolixServer {
  readonly port: number;
  /** Rooms running in this process, by id. */
  readonly rooms: ReadonlyMap<string, Room>;
  /** Whether rooms on this server may ask joiners for a captcha. */
  readonly captcha: boolean;
  /** Base64url P-256 point that checks verified identities; rooms take it with setVerifyKey. */
  readonly verifyKey: string;
  /** Serves a room running in this process (a host script) until the server closes; the caller starts it. */
  addRoom(room: Room, request: CreateRoomRequest): string;
  /** Bans these auths from every room this lobby serves, replacing the last list; they also get no captcha proof. */
  setBans(auths: Iterable<string>): void;
  close(): Promise<void>;
}

interface Joiner {
  ws: WebSocket;
  conn: string;
  /** The host has heard of this peer. */
  announced: boolean;
  relayed: boolean;
}

interface HostedRoom {
  ws: WebSocket;
  listing: RoomListing;
  public: boolean;
  joiners: Map<number, Joiner>;
  nextPeer: number;
  /** Set while the host is gone and the room waits for it to register again. */
  orphaned: ReturnType<typeof setTimeout> | null;
}

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 30;
const MAX_SDP = 16 * 1024;
const MAX_CANDIDATE = 1024;
const REGISTER_TIMEOUT_MS = 10_000;
const DEFAULT_HOST_GRACE_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const PEER_HEADER = 4;
const MAX_PAYLOAD = MAX_MESSAGE_BYTES + PEER_HEADER;
const DEFAULT_REGISTRATION_LIMIT = 10;
const DEFAULT_REGISTRATION_WINDOW_MS = 10 * 60_000;
// Generous, since mobile carriers and internet cafes put many players behind one address.
const DEFAULT_OPEN_PER_IP = 30;
const DEFAULT_CONNECTS_PER_IP = 30;
const DEFAULT_CONNECT_WINDOW_MS = 10_000;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
/** The base64url uncompressed P-256 point a client's identity exports as its auth. */
const AUTH = /^[A-Za-z0-9_-]{87}$/;
const VERIFIED_DAYS = 30;
const ROOM_TOKEN_MS = 10 * 60_000;
const TOKENS_PER_WINDOW = 10;
const TOKEN_WINDOW_MS = 10 * 60_000;
const ROOM_ID_LENGTH = 11;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' };

function parseCreateRequest(raw: Record<string, unknown>): CreateRoomRequest | null {
  const { name, maxPlayers, public: isPublic, country, lat, lon } = raw;
  const coordinate = (v: unknown, limit: number): v is number => typeof v === 'number' && Math.abs(v) <= limit;
  if (typeof name !== 'string' || typeof isPublic !== 'boolean') return null;
  if (typeof maxPlayers !== 'number' || !Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) return null;
  if (typeof country !== 'string' || !/^([a-z]{2})?$/.test(country) || !coordinate(lat, 90) || !coordinate(lon, 180)) return null;
  return { name: [...name].slice(0, LIMITS.roomName).join(''), maxPlayers, public: isPublic, country, lat, lon };
}

/** A connection report from a player's client, as POST /telemetry accepts it. */
export interface NetReport {
  path: 'p2p' | 'relay';
  seconds: number;
  ping: NetSummary | null;
  inputDelay: NetSummary | null;
  stalls: number;
  desyncs: number;
  extrapolation: number;
  country: string;
}

export interface NetSummary {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

const MAX_TELEMETRY_BYTES = 2048;
const TELEMETRY_PER_MINUTE = 6;

function count(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

function parseSummary(v: unknown): NetSummary | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'object') return undefined;
  const { n, p50, p95, max } = v as Record<string, unknown>;
  const ms = 60_000;
  return count(n, 100_000) && count(p50, ms) && count(p95, ms) && count(max, ms) ? { n, p50, p95, max } : undefined;
}

/** Copies only the known fields; null when anything is off. */
function parseReport(raw: unknown, country: string): NetReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const ping = parseSummary(r.ping);
  const inputDelay = parseSummary(r.inputDelay);
  if (r.v !== 1 || (r.path !== 'p2p' && r.path !== 'relay') || ping === undefined || inputDelay === undefined) return null;
  if (!count(r.seconds, 7 * 24 * 3600) || !count(r.stalls, 1_000_000) || !count(r.desyncs, 1_000_000)) return null;
  if (typeof r.extrapolation !== 'number' || !Number.isFinite(r.extrapolation) || Math.abs(r.extrapolation) > 1000) return null;
  return { path: r.path, seconds: r.seconds, ping, inputDelay, stalls: r.stalls, desyncs: r.desyncs, extrapolation: r.extrapolation, country };
}

/** One auth per line; `#` starts a comment, for the reason. */
export function parseBanList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => AUTH.test(line));
}

function parseCandidate(raw: unknown): IceCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { candidate, sdpMid, sdpMLineIndex } = raw as Record<string, unknown>;
  if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE) return null;
  if (sdpMid !== null && (typeof sdpMid !== 'string' || sdpMid.length > MAX_CANDIDATE)) return null;
  if (sdpMLineIndex !== null && (typeof sdpMLineIndex !== 'number' || !Number.isInteger(sdpMLineIndex))) return null;
  return { candidate, sdpMid, sdpMLineIndex };
}

/** A JSON object with a string `type`, or null. */
function parseText(data: RawData): Record<string, unknown> & { type: string } | null {
  try {
    const msg: unknown = JSON.parse(data.toString());
    return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string' ? (msg as Record<string, unknown> & { type: string }) : null;
  } catch {
    return null;
  }
}

function isToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN.test(v);
}

function isSdp(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_SDP;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function send(ws: WebSocket, msg: ServerToHost | ServerToJoiner): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function blockList(ranges: string[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    const [net, prefix] = range.split('/');
    list.addSubnet(net, Number(prefix), isIP(net) === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** Where a reverse proxy in front of the server runs: this machine or its private (Docker) networks. */
const PROXIES = blockList(['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7']);
/** https://www.cloudflare.com/ips/ */
const CLOUDFLARE = blockList([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]);

function unmapped(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

function inList(list: BlockList, ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** The address that reached us: the socket's, or the last X-Forwarded-For hop when a local proxy sits in front. */
function peerIp(req: IncomingMessage): string {
  const socket = unmapped(req.socket.remoteAddress ?? '');
  const forwarded = req.headers['x-forwarded-for'];
  return typeof forwarded === 'string' && inList(PROXIES, socket) ? unmapped(forwarded.split(',').at(-1)!.trim()) : socket;
}

/** Cloudflare's headers are only believed from Cloudflare's own addresses, since the origin is reachable without it. */
function cloudflareHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' && inList(CLOUDFLARE, peerIp(req)) ? value : null;
}

/** Cloudflare's CF-Connecting-IP, else the address that reached us. */
function clientIp(req: IncomingMessage): string {
  return unmapped(cloudflareHeader(req, 'cf-connecting-ip') ?? peerIp(req));
}

/** Cloudflare's CF-IPCountry, which is XX for unknown and T1 for Tor; empty without Cloudflare. */
function visitorCountry(req: IncomingMessage): string {
  const lower = (cloudflareHeader(req, 'cf-ipcountry') ?? '').toLowerCase();
  return /^[a-z]{2}$/.test(lower) && lower !== 'xx' ? lower : '';
}

function connOf(req: IncomingMessage): string {
  return Buffer.from(clientIp(req)).toString('hex').toUpperCase();
}

/**
 * Lobby and signaling server. A browser host opens ws://host:port/host, registers its room and keeps the socket
 * open; the room is listed at GET /rooms until that socket closes. A joiner opens ws://host:port/room/<id> to trade
 * WebRTC offers, answers and ICE candidates with the host, or to relay its game bytes through the server.
 * GET /lobby tells a visitor its country and the server notice.
 */
export async function createServer(options: ServerOptions): Promise<GolixServer> {
  const rooms = new Map<string, Room>();
  const requests = new Map<string, CreateRoomRequest>();
  const hosted = new Map<string, HostedRoom>();
  const newId = () => randomBytes(8).toString('base64url');
  const notice = options.notice ?? '';
  const registrationLimit = options.roomRegistrations?.limit ?? DEFAULT_REGISTRATION_LIMIT;
  const registrationWindowMs = options.roomRegistrations?.windowMs ?? DEFAULT_REGISTRATION_WINDOW_MS;
  const registrations = new Map<string, { at: number; id: string }[]>();
  const openPerIp = options.connections?.open ?? DEFAULT_OPEN_PER_IP;
  const connectsPerIp = options.connections?.limit ?? DEFAULT_CONNECTS_PER_IP;
  const connectWindowMs = options.connections?.windowMs ?? DEFAULT_CONNECT_WINDOW_MS;
  const open = new Map<string, number>();
  const connects = new Map<string, number[]>();

  /** Counts the attempt when it is let through. */
  const allowConnect = (ip: string): boolean => {
    const now = Date.now();
    const recent = (connects.get(ip) ?? []).filter((at) => now - at < connectWindowMs);
    const allowed = (open.get(ip) ?? 0) < openPerIp && recent.length < connectsPerIp;
    if (allowed) recent.push(now);
    connects.set(ip, recent);
    return allowed;
  };

  /** Only the secret's holder can register an id again, so a restarting host does not count as a new room. */
  const allowRegistration = (ip: string, id: string): boolean => {
    const now = Date.now();
    const recent = (registrations.get(ip) ?? []).filter((r) => now - r.at < registrationWindowMs);
    const allowed = recent.some((r) => r.id === id) || recent.length < registrationLimit;
    if (allowed && !recent.some((r) => r.id === id)) recent.push({ at: now, id });
    registrations.set(ip, recent);
    return allowed;
  };

  const iceServers = (): IceServer[] => {
    const servers: IceServer[] = options.stunUrls?.length ? [{ urls: options.stunUrls }] : [];
    const { turn } = options;
    if (turn !== undefined) {
      const username = `${Math.floor(Date.now() / 1000) + turn.ttlSeconds}:golix`;
      servers.push({ urls: turn.urls, username, credential: createHmac('sha1', turn.secret).update(username).digest('base64') });
    }
    return servers;
  };

  const listRooms = (): RoomListing[] => [
    ...[...rooms].flatMap(([id, room]) => {
      const { public: isPublic, country, lat, lon } = requests.get(id)!;
      const { state } = room;
      return isPublic
        ? [{ id, name: state.name, players: state.players.length, maxPlayers: state.maxPlayers, hasPassword: state.hasPassword, captcha: room.captchaRequired, actionKeys: state.actionKeys, country, lat, lon }]
        : [];
    }),
    ...[...hosted.values()].flatMap((h) => (h.public ? [h.listing] : [])),
  ];

  let bans: ReadonlySet<string> = new Set();
  const addRoom = (room: Room, request: CreateRoomRequest): string => {
    room.setVerifyKey(Buffer.from(verifyKey, 'base64url'));
    room.setGlobalBans(bans);
    const id = newId();
    rooms.set(id, room);
    requests.set(id, request);
    return id;
  };

  const telemetry = options.telemetry ?? ((report: NetReport) => console.log(JSON.stringify({ telemetry: report })));
  const telemetryCalls = new Map<string, number[]>();
  const receiveTelemetry = (req: IncomingMessage, res: ServerResponse) => {
    const now = Date.now();
    const ip = clientIp(req);
    const recent = (telemetryCalls.get(ip) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= TELEMETRY_PER_MINUTE) return void res.writeHead(429, CORS).end();
    telemetryCalls.set(ip, [...recent, now]);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_TELEMETRY_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      let report: NetReport | null = null;
      try {
        report = parseReport(JSON.parse(Buffer.concat(chunks).toString()), visitorCountry(req));
      } catch {
        report = null;
      }
      if (report !== null) telemetry(report);
      res.writeHead(report === null ? 400 : 204, CORS).end();
    });
  };

  const routes = new Map<string, (req: IncomingMessage) => unknown>([
    ['/rooms', () => listRooms()],
    ['/lobby', (req): LobbyInfo => ({ country: visitorCountry(req), notice, captchaSiteKey: options.captcha?.siteKey ?? '' })],
  ]);

  const http = createHttpServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/telemetry' && req.method === 'POST') return receiveTelemetry(req, res);
    if (pathname === '/token' && req.method === 'POST') return giveRoomToken(req, res);
    const route = routes.get(pathname);
    if (route === undefined) return void res.writeHead(404).end();
    if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
    if (req.method === 'GET') return sendJson(res, 200, route(req));
    res.writeHead(405, CORS).end();
  });
  const identityKey = options.identityKey ?? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const { x, y } = createPublicKey(identityKey).export({ format: 'jwk' });
  const verifyKey = Buffer.concat([Buffer.from([4]), Buffer.from(x!, 'base64url'), Buffer.from(y!, 'base64url')]).toString('base64url');
  /** `<expires, unix seconds>.<signature>` over verifiedMessage, which rooms check with verifyKey. */
  const verify = (auth: string): string => {
    const expires = Math.floor(Date.now() / 1000) + VERIFIED_DAYS * 86_400;
    const signature = sign('sha256', Buffer.from(verifiedMessage(auth, expires)), { key: identityKey, dsaEncoding: 'ieee-p1363' });
    return `${expires}.${signature.toString('base64url')}`;
  };
  const startedAt = Date.now();
  /** Nonce → expiry of room tokens already used, so each opens one room. */
  const usedRoomTokens = new Map<string, number>();
  const roomTokenMessage = (expires: number, nonce: string) => `golix-room-token.${expires}.${nonce}`;
  const issueRoomToken = (): string => {
    const expires = Date.now() + ROOM_TOKEN_MS;
    const nonce = randomBytes(9).toString('base64url');
    return `${expires}.${nonce}.${sign('sha256', Buffer.from(roomTokenMessage(expires, nonce)), { key: identityKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  /** Checks a room token and spends it. */
  const spendRoomToken = (token: unknown): boolean => {
    if (typeof token !== 'string') return false;
    const [expires, nonce, signature] = token.split('.');
    const until = Number(expires);
    if (nonce === undefined || signature === undefined || !Number.isInteger(until) || until < Date.now() || usedRoomTokens.has(nonce)) return false;
    const ok = verifySignature('sha256', Buffer.from(roomTokenMessage(until, nonce)), { key: createPublicKey(identityKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
    if (ok) usedRoomTokens.set(nonce, until);
    return ok;
  };
  const tokenCalls = new Map<string, number[]>();
  /** POST /token with a solved captcha as the body answers { token }, good for one room for ten minutes. */
  const giveRoomToken = (req: IncomingMessage, res: ServerResponse) => {
    const now = Date.now();
    const ip = clientIp(req);
    const recent = (tokenCalls.get(ip) ?? []).filter((at) => now - at < TOKEN_WINDOW_MS);
    if (options.captcha === undefined || options.roomTokens === undefined) return void res.writeHead(404, CORS).end();
    if (recent.length >= TOKENS_PER_WINDOW) return void res.writeHead(429, CORS).end();
    tokenCalls.set(ip, [...recent, now]);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_TELEMETRY_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      options.captcha!.verify(Buffer.concat(chunks).toString().trim(), ip).then(
        (ok) => (ok ? sendJson(res, 200, { token: issueRoomToken() }) : void res.writeHead(403, CORS).end()),
        () => void res.writeHead(502, CORS).end(),
      );
    });
  };
  /** Joiner connections whose captcha token the provider accepted during the upgrade, with the proof for the auth they named. */
  const solved = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_PAYLOAD,
    verifyClient: ({ req }: { req: IncomingMessage }, accept: (ok: boolean, code?: number, message?: string) => void) => {
      if (!allowConnect(clientIp(req))) return accept(false, 429, 'Too many connections from your address');
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const token = params.get('captcha');
      if (token === null || options.captcha === undefined) return accept(true);
      const auth = params.get('auth') ?? '';
      options.captcha.verify(token, clientIp(req)).then(
        (ok) => {
          if (ok) solved.set(req, AUTH.test(auth) && !bans.has(auth) ? verify(auth) : '');
          accept(true);
        },
        () => accept(true),
      );
    },
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, resolve);
  });

  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [ip, recent] of registrations) if (recent.every((r) => now - r.at >= registrationWindowMs)) registrations.delete(ip);
    for (const [ip, recent] of connects) if (recent.every((at) => now - at >= connectWindowMs)) connects.delete(ip);
    for (const [ip, recent] of telemetryCalls) if (recent.every((at) => now - at >= 60_000)) telemetryCalls.delete(ip);
    for (const [ip, recent] of tokenCalls) if (recent.every((at) => now - at >= TOKEN_WINDOW_MS)) tokenCalls.delete(ip);
    for (const [nonce, until] of usedRoomTokens) if (until < now) usedRoomTokens.delete(nonce);
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  const serveHost = (ws: WebSocket, ip: string) => {
    let room: HostedRoom | null = null;
    let id = '';
    const timer = setTimeout(() => ws.close(), REGISTER_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      if (room === null) {
        const msg = isBinary ? null : parseText(data);
        const request = msg?.type === 'register' ? parseCreateRequest(msg) : null;
        if (msg === null || request === null || typeof msg.hasPassword !== 'boolean' || !isToken(msg.secret)) return void ws.close();
        id = createHash('sha256').update(msg.secret).digest('base64url').slice(0, ROOM_ID_LENGTH);
        if (rooms.has(id)) return void ws.close();
        const previous = hosted.get(id);
        const known = options.roomTokens === undefined || previous !== undefined || options.roomTokens.known.has(id) || Date.now() - startedAt < (options.roomTokens.graceMs ?? 60_000);
        if (!known && !spendRoomToken(msg.token)) return void ws.close(1008, 'Opening a room needs a token from /headlesstoken');
        if (previous === undefined && !allowRegistration(ip, id)) return void ws.close(1008, 'Too many rooms created, try again later');
        options.roomTokens?.known.add(id);
        clearTimeout(timer);
        const listing = {
          id,
          name: request.name,
          players: 0,
          maxPlayers: request.maxPlayers,
          hasPassword: msg.hasPassword,
          captcha: msg.captcha === true,
          actionKeys: msg.actionKeys === true,
          country: request.country,
          lat: request.lat,
          lon: request.lon,
        };
        if (previous === undefined) {
          room = { ws, public: request.public, joiners: new Map(), nextPeer: 1, listing, orphaned: null };
          hosted.set(id, room);
        } else {
          // Only the holder of the secret can register this id, so it takes over the room and keeps its players' sockets.
          room = previous;
          const stale = room.ws;
          clearTimeout(room.orphaned ?? undefined);
          Object.assign(room, { ws, public: request.public, listing, orphaned: null });
          stale.terminate();
        }
        send(ws, { type: 'registered', id, captcha: options.captcha !== undefined, verifyKey });
        // A room starts with no bans, so only a list with something in it needs sending.
        if (bans.size > 0) send(ws, { type: 'bans', auths: [...bans] });
        return;
      }
      if (isBinary) {
        const bytes = data as Buffer;
        if (bytes.length < PEER_HEADER) return void ws.close();
        const joiner = room.joiners.get(bytes.readUInt32BE(0));
        if (joiner?.relayed && joiner.ws.readyState === joiner.ws.OPEN) joiner.ws.send(bytes.subarray(PEER_HEADER));
        return;
      }
      const msg = parseText(data);
      if (msg === null) return void ws.close();
      if (msg.type === 'update') {
        const maxPlayers = msg.maxPlayers ?? room.listing.maxPlayers;
        if (typeof maxPlayers !== 'number' || !Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) return void ws.close();
        if (typeof msg.players !== 'number' || !Number.isInteger(msg.players) || msg.players < 0 || msg.players > MAX_PLAYERS || typeof msg.hasPassword !== 'boolean') return void ws.close();
        if (msg.name !== undefined && typeof msg.name !== 'string') return void ws.close();
        if (msg.name !== undefined) room.listing.name = [...msg.name].slice(0, LIMITS.roomName).join('');
        room.listing.maxPlayers = maxPlayers;
        room.listing.players = msg.players;
        room.listing.hasPassword = msg.hasPassword;
        room.listing.captcha = msg.captcha === true;
        room.listing.actionKeys = msg.actionKeys === true;
        return;
      }
      const joiner = typeof msg.peer === 'number' ? room.joiners.get(msg.peer) : undefined;
      if (joiner === undefined) return;
      if (msg.type === 'answer' && isSdp(msg.sdp)) send(joiner.ws, { type: 'answer', sdp: msg.sdp });
      else if (msg.type === 'candidate') {
        const candidate = parseCandidate(msg.candidate);
        if (candidate !== null) send(joiner.ws, { type: 'candidate', candidate });
      } else if (msg.type === 'close') joiner.ws.close();
    });
    ws.on('close', () => {
      clearTimeout(timer);
      const lost = room;
      if (lost === null || lost.ws !== ws) return;
      // Relayed players resume on their own once the host is back, so only their sockets close now.
      for (const [peer, joiner] of lost.joiners) {
        if (!joiner.relayed) {
          send(joiner.ws, { type: 'hostAway' });
          continue;
        }
        lost.joiners.delete(peer);
        joiner.ws.close(HOST_AWAY_CLOSE);
      }
      lost.orphaned = setTimeout(() => {
        if (hosted.get(id) !== lost || lost.ws !== ws) return;
        hosted.delete(id);
        for (const joiner of lost.joiners.values()) {
          send(joiner.ws, { type: 'hostLost' });
          joiner.ws.close();
        }
      }, options.hostGraceMs ?? DEFAULT_HOST_GRACE_MS);
    });
  };

  const serveJoiner = (ws: WebSocket, room: HostedRoom, conn: string, captcha: boolean) => {
    if (room.orphaned !== null) return void ws.close();
    const peer = room.nextPeer++;
    const joiner: Joiner = { ws, conn, announced: false, relayed: false };
    room.joiners.set(peer, joiner);
    send(ws, { type: 'webrtc', iceServers: iceServers() });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!joiner.relayed) return void ws.close();
        const bytes = data as Buffer;
        const frame = Buffer.allocUnsafe(PEER_HEADER + bytes.length);
        frame.writeUInt32BE(peer, 0);
        bytes.copy(frame, PEER_HEADER);
        if (room.ws.readyState === room.ws.OPEN) room.ws.send(frame);
        return;
      }
      const msg = parseText(data);
      if (msg === null || joiner.relayed) return void ws.close();
      if (msg.type === 'offer' && isSdp(msg.sdp)) {
        joiner.announced = true;
        send(room.ws, { type: 'offer', peer, conn, captcha, sdp: msg.sdp, iceServers: iceServers() });
      } else if (msg.type === 'candidate') {
        const candidate = parseCandidate(msg.candidate);
        if (candidate !== null && joiner.announced) send(room.ws, { type: 'candidate', peer, candidate });
      } else if (msg.type === 'relay' && isToken(msg.token)) {
        joiner.announced = true;
        joiner.relayed = true;
        send(room.ws, { type: 'relay', peer, conn, captcha, token: msg.token });
      } else ws.close();
    });
    ws.on('close', () => {
      room.joiners.delete(peer);
      if (joiner.announced) send(room.ws, { type: 'leave', peer });
    });
  };

  const serveLocal = (ws: WebSocket, room: Room, conn: string, captcha: boolean) => {
    send(ws, { type: 'relay' });
    const peer = room.addPeer(
      {
        send: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(data);
        },
        close: () => ws.close(),
      },
      conn,
      captcha,
    );
    ws.on('message', (data, isBinary) => {
      if (isBinary && data instanceof Uint8Array) peer.receive(data);
    });
    ws.on('close', () => peer.closed());
  };

  wss.on('connection', (ws: WebSocket, req) => {
    const ip = clientIp(req);
    open.set(ip, (open.get(ip) ?? 0) + 1);
    ws.on('close', () => {
      const left = (open.get(ip) ?? 1) - 1;
      if (left > 0) open.set(ip, left);
      else open.delete(ip);
    });
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/host') return serveHost(ws, ip);
    const proof = solved.get(req);
    if (proof) send(ws, { type: 'verified', value: proof });
    const id = /^\/room\/(.*)$/.exec(path)?.[1] ?? '';
    const room = hosted.get(id);
    if (room !== undefined) return serveJoiner(ws, room, connOf(req), solved.has(req));
    const own = rooms.get(id);
    if (own !== undefined) return serveLocal(ws, own, connOf(req), solved.has(req));
    ws.send(encodeServerMessage({ type: 'joinRejected', reason: 'invalid' }));
    ws.close();
  });

  return {
    port: (http.address() as { port: number }).port,
    rooms,
    captcha: options.captcha !== undefined,
    verifyKey,
    addRoom,
    setBans: (auths) => {
      bans = new Set(auths);
      for (const room of rooms.values()) room.setGlobalBans(bans);
      for (const h of hosted.values()) send(h.ws, { type: 'bans', auths: [...bans] });
    },
    close: () => {
      clearInterval(heartbeat);
      for (const room of rooms.values()) room.close();
      rooms.clear();
      requests.clear();
      hosted.clear();
      registrations.clear();
      open.clear();
      connects.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      return new Promise((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
