import { applyThemeVariables, defaultTheme, startClockWorker, workerSchedule } from '@golix/client';
import { HBInit, type RoomConfigObject, type RoomObject } from '../src/index.ts';
import './style.css';

declare global {
  interface Window {
    HBInit: typeof HBInit;
  }
}

const LOBBY: string = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8787';
const STORAGE_KEY = 'golix.headless.script';
const LEVELS = ['log', 'info', 'warn', 'error'] as const;

const script = document.getElementById('script') as HTMLTextAreaElement;
const run = document.getElementById('run') as HTMLButtonElement;
const stop = document.getElementById('stop') as HTMLButtonElement;
const link = document.getElementById('link') as HTMLAnchorElement;
const log = document.getElementById('log') as HTMLPreElement;

applyThemeVariables(document.documentElement, defaultTheme);

function append(level: (typeof LEVELS)[number], text: string): void {
  const line = document.createElement('div');
  line.className = level;
  line.textContent = text;
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

for (const level of LEVELS) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    append(level, args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' '));
  };
}
addEventListener('error', (e) => append('error', e.message));
addEventListener('unhandledrejection', (e) => append('error', String(e.reason)));

/** HBInit on this page's lobby, ticking on a worker clock, with the room link shown on the page. */
window.HBInit = (config: RoomConfigObject = {}): RoomObject => {
  const room = HBInit({ lobby: LOBBY, clientUrl: location.origin, schedule: workerSchedule(startClockWorker(), () => {}), ...config });
  let own: RoomObject['onRoomLink'];
  Object.defineProperty(room, 'onRoomLink', {
    get: () => (url: string) => {
      link.href = link.textContent = url;
      own?.(url);
    },
    set: (fn: RoomObject['onRoomLink']) => (own = fn),
  });
  return room;
};

try {
  script.value = localStorage.getItem(STORAGE_KEY) ?? '';
} catch {
  // Without storage the script is not remembered.
}

run.addEventListener('click', () => {
  try {
    localStorage.setItem(STORAGE_KEY, script.value);
  } catch {
    // As above.
  }
  run.disabled = script.readOnly = true;
  stop.disabled = false;
  try {
    new Function(script.value)();
  } catch (e) {
    append('error', String(e));
  }
});
stop.addEventListener('click', () => location.reload());

globalThis.onHBLoaded?.();
