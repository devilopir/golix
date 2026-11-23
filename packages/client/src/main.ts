import { TICKS_PER_SECOND, cloneRoom, hashRoom, type RoomState } from '@golix/shared';
import { SoundPlayer } from './audio/player.ts';
import { mountGameView } from './gameView.ts';
import { startClockWorker, workerSchedule } from './net/clock.ts';
import { watchNetStats } from './net/telemetry.ts';
import { hostRoom, type HostedRoom } from './net/host.ts';
import { JoinError, NetSession } from './net/netSession.ts';
import { recordMatches, recordSession, replayFileName } from './net/recording.ts';
import { indexedDbReplays } from './net/replayStore.ts';
import { httpRoomList, parseRoomLink, roomLink } from './net/roomList.ts';
import { countryGeo } from './ui/countries.ts';
import type { Connect } from './net/transport.ts';
import type { RoomSession } from './session.ts';
import { loadIdentity, signNonce } from './settings/identity.ts';
import { createSettingsStore, type Geo } from './settings/settings.ts';
import { defaultTheme } from './theme/index.ts';
import { App } from './ui/app.ts';
import { solveCaptcha } from './ui/captcha.ts';
import { replayLink } from './ui/replayViewer.ts';
import { downloadFile } from './ui/stadiums.ts';
import './ui/styles.css';

/** Read-only view of the joined room for end-to-end tests; only set in dev builds. */
export interface GolixDebug {
  playerId: number;
  /** Copy of the server-confirmed room. */
  room(): RoomState;
  /** Last confirmed server tick. */
  tick(): number;
  /** Hash of the confirmed room after `tick`, kept for the last DEBUG_HASH_TICKS ticks. */
  hashAt(tick: number): number | undefined;
  sync: { readonly checked: number; readonly desyncs: number };
}

declare global {
  interface Window {
    __golix?: GolixDebug;
  }
}

const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8787';
const DEBUG_HASH_TICKS = 600;
/** A tick timer this late in a hidden tab means the browser still throttles the worker. */
const HIDDEN_LAG_NOTICE_MS = 250;
const HIDDEN_LAG_NOTICE = 'Your browser is slowing this tab down while it is in the background, so the game stutters for everyone. Keep this tab visible while you host.';
const JOIN_ERRORS: Readonly<Record<JoinError['reason'], string>> = {
  password: 'Wrong password.',
  full: 'The room is full.',
  banned: 'You are banned from this room.',
  invalid: 'The room was closed.',
  closed: 'Could not connect to the room.',
  rateLimited: 'Too many join attempts from your address. Try again in a minute.',
  captcha: 'This room only lets in players who solve the captcha.',
  connLimit: 'Too many players from your address are already in this room.',
  version: 'Golix has been updated. Reload the page to join; if this stays, the room is running another version.',
};

const settings = createSettingsStore(localStorage);
const sounds = new SoundPlayer(new AudioContext(), () => ({
  soundEnabled: settings.get('soundEnabled'),
  chatSoundEnabled: settings.get('chatSoundEnabled'),
  highlightSoundEnabled: settings.get('highlightSoundEnabled'),
  crowdSoundEnabled: settings.get('crowdSoundEnabled'),
  volume: settings.get('volume'),
}));
const identity = loadIdentity(localStorage);
const roomIds = new WeakMap<RoomSession, string>();
const recordings = new Map<RoomSession, () => Uint8Array<ArrayBuffer>>();
const savedReplays = 'indexedDB' in globalThis ? indexedDbReplays(indexedDB) : null;
const hostedRooms = new WeakMap<RoomSession, HostedRoom>();
let current: NetSession | null = null;
let handicap = 0;

settings.subscribe((key) => {
  if (key === 'extrapolation') current?.setExtrapolation(settings.get('extrapolation'));
});

function exposeDebug(session: NetSession): void {
  const hashes = new Map<number, number>();
  let last = 0;
  session.onTick((tick) => {
    last = tick;
    hashes.set(tick, hashRoom(session.getRoom()));
    hashes.delete(tick - DEBUG_HASH_TICKS);
  });
  window.__golix = {
    playerId: session.playerId,
    room: () => cloneRoom(session.getRoom()),
    tick: () => last,
    hashAt: (tick) => hashes.get(tick),
    sync: session.sync,
  };
}

function saveRecording(session: RoomSession): void {
  const stop = recordings.get(session);
  if (stop === undefined) return;
  recordings.delete(session);
  downloadFile(replayFileName(session.getRoom().name, new Date()), stop());
}

const rooms = httpRoomList(SERVER_URL);

/** A room link can join before the room list has stored the detected country, so detect it here too. */
async function detectedGeo(): Promise<Geo | null> {
  const saved = settings.get('geo');
  if (saved !== null) return saved;
  const geo = countryGeo((await rooms.lobby().catch(() => null))?.country ?? '');
  if (geo !== null) settings.set('geo', geo);
  return geo;
}

/** A lobby with captcha keys asks a new room for a token, which a solved captcha buys; undefined where none is needed. */
async function roomToken(): Promise<string | undefined> {
  const siteKey = (await rooms.lobby().catch(() => null))?.captchaSiteKey ?? '';
  if (siteKey === '') return undefined;
  const solved = await solveCaptcha(document.getElementById('app')!, siteKey, 'Prove you are not a bot to open a room.');
  if (solved === null) throw new Error('Opening a room needs the captcha solved.');
  const res = await fetch(`${SERVER_URL.replace(/^ws/, 'http')}/token`, { method: 'POST', body: solved });
  if (!res.ok) throw new Error('Could not create the room.');
  return ((await res.json()) as { token: string }).token;
}

const VERIFIED_KEY = 'golix.verified';

/** The lobby's proof that this browser's identity solved a captcha, if it is still valid. */
function storedProof(auth: string): string {
  try {
    const stored = JSON.parse(localStorage.getItem(VERIFIED_KEY) ?? 'null') as { auth: string; value: string } | null;
    return stored !== null && stored.auth === auth && Number(stored.value.split('.')[0]) * 1000 > Date.now() ? stored.value : '';
  } catch {
    return '';
  }
}

/** `captcha` is a solved token the lobby checks when the room asks for one; it also earns a proof that skips later captchas. */
async function connect(id: string, password: string, via?: Connect, captcha?: string): Promise<NetSession> {
  const country = (await detectedGeo())?.code ?? '';
  const { authId } = await identity;
  let session: NetSession;
  try {
    session = await NetSession.join({
      url: `${SERVER_URL}/room/${id}${captcha === undefined ? '' : `?captcha=${encodeURIComponent(captcha)}&auth=${authId}`}`,
      join: { name: settings.get('nickname'), avatar: settings.get('avatar'), country, password, auth: authId, verified: storedProof(authId) },
      onVerified: (value) => {
        try {
          localStorage.setItem(VERIFIED_KEY, JSON.stringify({ auth: authId, value }));
        } catch {
          // Without storage the player just solves the captcha again next time.
        }
      },
      sign: async (nonce) => signNonce(await identity, nonce),
      extrapolation: settings.get('extrapolation'),
      handicap,
      connect: via,
    });
  } catch (e) {
    if (e instanceof JoinError && e.reason === 'captcha' && captcha === undefined) {
      const siteKey = (await rooms.lobby().catch(() => null))?.captchaSiteKey ?? '';
      const token = siteKey === '' ? null : await solveCaptcha(document.getElementById('app')!, siteKey);
      if (token !== null) return connect(id, password, via, token);
    }
    throw e instanceof JoinError ? new Error(JOIN_ERRORS[e.reason]) : e;
  }
  roomIds.set(session, id);
  current = session;
  if (session.path !== 'host') {
    const report = watchNetStats(session, () => settings.get('extrapolation'));
    session.onClose(() => navigator.sendBeacon(`${SERVER_URL.replace(/^ws/, 'http')}/telemetry`, JSON.stringify(report())));
  }
  if (savedReplays !== null && settings.get('saveMatches')) {
    const stopMatches = recordMatches(session, () => handicap, (data, ticks) => {
      savedReplays.add({ roomName: session.getRoom().name, savedAt: Date.now(), seconds: ticks / TICKS_PER_SECOND }, data).catch(() => {});
    });
    session.onClose(stopMatches);
  }
  session.onClose(() => {
    if (current === session) current = null;
    saveRecording(session);
  });
  mountGameView({ session, layer: app.gameLayer, settings, theme: defaultTheme, menuOpen: () => app.menuOpen, playSound: (name) => sounds.play(name), stopSounds: () => sounds.stopAll() });
  if (import.meta.env.DEV) exposeDebug(session);
  return session;
}

const app = new App({
  root: document.getElementById('app')!,
  settings,
  storage: localStorage,
  theme: defaultTheme,
  rooms,
  join: (entry, password) => connect(entry.id, password),
  create: async (options) => {
    const geo = await detectedGeo();
    const token = await roomToken();
    const clock = startClockWorker();
    let warned = false;
    const onVisibility = () => {
      if (!document.hidden) warned = false;
    };
    const schedule = workerSchedule(clock, (lateMs) => {
      if (!document.hidden || warned || lateMs < HIDDEN_LAG_NOTICE_MS) return;
      warned = true;
      app.notice(HIDDEN_LAG_NOTICE);
    });
    let hosted: HostedRoom;
    try {
      hosted = await hostRoom({
        serverUrl: SERVER_URL,
        request: { name: options.name, maxPlayers: options.maxPlayers, public: options.public, country: geo?.code ?? '', lat: geo?.lat ?? 0, lon: geo?.lon ?? 0 },
        password: options.password,
        schedule,
        token,
      });
    } catch (e) {
      clock.terminate();
      throw e;
    }
    const close = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      hosted.close();
      clock.terminate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    try {
      const session = await connect(hosted.id, options.password, hosted.connect);
      hostedRooms.set(session, hosted);
      addEventListener('pagehide', close);
      session.onClose(() => {
        removeEventListener('pagehide', close);
        close();
      });
      return session;
    } catch (e) {
      close();
      throw e;
    }
  },
  roomLink: (session) => roomLink(location.origin, roomIds.get(session)!, session.getRoom().hasPassword),
  playSound: (name) => sounds.play(name),
  replays: savedReplays,
  setRecording: (session, recording) => {
    if (recording) recordings.set(session, recordSession(session, () => handicap));
    else saveRecording(session);
  },
  setRecaptcha: (session, required) => hostedRooms.get(session)?.setRequireRecaptcha(required) ?? null,
  hostEvents: (session) => {
    const hosted = hostedRooms.get(session);
    return hosted === undefined ? null : (ev) => hosted.room.hostEvent(ev);
  },
  setHandicap: (ms) => {
    handicap = ms;
    current?.setHandicap(ms);
  },
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');

app.start(parseRoomLink(location.search), replayLink(location));
