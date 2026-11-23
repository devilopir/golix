import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, readFileSync, watchFile, writeFileSync } from 'node:fs';
import { createServer, parseBanList, type NetReport } from './server.ts';

function positiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? 'localhost';
const turnUrls = list(process.env.TURN_URLS);
const turnSecret = process.env.TURN_SECRET ?? '';
const turnTtlSeconds = Number(process.env.TURN_TTL_SECONDS ?? 86_400);
if (turnUrls.length > 0 && turnSecret === '') throw new Error('TURN_URLS is set but TURN_SECRET is empty');
if (!Number.isInteger(turnTtlSeconds) || turnTtlSeconds <= 0) throw new Error('TURN_TTL_SECONDS must be a positive whole number');
const captchaSiteKey = process.env.TURNSTILE_SITE_KEY ?? '';
const captchaSecret = process.env.TURNSTILE_SECRET ?? '';
if ((captchaSiteKey === '') !== (captchaSecret === '')) throw new Error('Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET, or neither');

/** Cloudflare Turnstile's siteverify; a token passes once. */
async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: captchaSecret, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(5000),
  });
  return ((await res.json()) as { success?: unknown }).success === true;
}

// Container logs go with every redeploy, so connection reports are appended to a file on a volume when one is given.
const telemetryFile = process.env.TELEMETRY_FILE ?? '';
const telemetryOut = telemetryFile === '' ? null : createWriteStream(telemetryFile, { flags: 'a' });
const telemetry = telemetryOut === null ? undefined : (report: NetReport) => void telemetryOut.write(`${JSON.stringify({ at: new Date().toISOString(), ...report })}\n`);

/** The key that vouches for players who solved a captcha; it must outlive restarts, or every proof stops working. */
function identityKey(file: string): KeyObject | undefined {
  if (file === '') return undefined;
  if (existsSync(file)) return createPrivateKey(readFileSync(file));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  return privateKey;
}

/** Room ids that opened with a room token, one per line; with it a restarted bot room needs no new token. */
function knownRooms(file: string): { has(id: string): boolean; add(id: string): void } {
  const ids = new Set(file !== '' && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '') : []);
  return {
    has: (id) => ids.has(id),
    add: (id) => {
      if (ids.has(id)) return;
      ids.add(id);
      if (file !== '') appendFileSync(file, `${id}\n`);
    },
  };
}

const server = await createServer({
  telemetry,
  roomTokens: captchaSiteKey !== '' ? { known: knownRooms(process.env.KNOWN_ROOMS_FILE ?? '') } : undefined,
  identityKey: identityKey(process.env.LOBBY_KEY_FILE ?? ''),
  port,
  host: process.env.HOST,
  notice: process.env.LOBBY_NOTICE,
  roomRegistrations: { limit: positiveInt('ROOM_REGISTER_LIMIT'), windowMs: positiveInt('ROOM_REGISTER_WINDOW_MS') },
  stunUrls: list(process.env.STUN_URLS),
  turn: turnUrls.length > 0 ? { urls: turnUrls, secret: turnSecret, ttlSeconds: turnTtlSeconds } : undefined,
  captcha: captchaSiteKey !== '' ? { siteKey: captchaSiteKey, verify: verifyTurnstile } : undefined,
});
// Operators edit this file by hand; the lobby picks up changes within half a minute.
const bansFile = process.env.BANS_FILE ?? '';
if (bansFile !== '') {
  const load = () => server.setBans(existsSync(bansFile) ? parseBanList(readFileSync(bansFile, 'utf8')) : []);
  load();
  watchFile(bansFile, { interval: 30_000 }, load);
}

console.log(`Golix lobby listening on ws://${host}:${server.port} (/host, /room/<id>), room list at http://${host}:${server.port}/rooms`);
