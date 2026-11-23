import { ACTION_KEY_ACTIONS, DEFAULT_KEY_BINDINGS, normalizeKeyBindings, type BindableAction, type KeyBindings } from '../input/bindings.ts';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Geo {
  lat: number;
  lon: number;
  /** Lowercase ISO 3166-1 alpha-2 code. */
  code: string;
}

// -1 Dynamic, 0 Restricted 840x410, 1..7 Full 1x..2.5x zoom in 0.25 steps.
export type ViewMode = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const VIEW_MODES: readonly ViewMode[] = [-1, 0, 1, 2, 3, 4, 5, 6, 7];

export const NICKNAME_MAX_LENGTH = 25;
export const AVATAR_MAX_LENGTH = 2;

export interface Settings {
  nickname: string;
  avatar: string;
  geo: Geo | null;

  soundEnabled: boolean;
  chatSoundEnabled: boolean;
  highlightSoundEnabled: boolean;
  crowdSoundEnabled: boolean;
  volume: number;

  viewMode: ViewMode;
  /** 0 = no limit. */
  fpsLimit: 0 | 30;
  resolutionScale: 1 | 0.75 | 0.5 | 0.25;
  lowLatencyCanvas: boolean;
  teamColorsEnabled: boolean;
  chatIndicatorsEnabled: boolean;
  avatarsEnabled: boolean;
  chatOpacity: number;
  /** Chat log height in px while the chat is not focused, set by dragging its top edge. */
  chatHeight: number;
  chatFocusHeight: number;
  chatBackgroundWidth: 'full' | 'compact';
  /** Off: players joining and leaving leave no chat line or sound; kicks and bans still do. */
  joinLeaveNotices: boolean;
  /** Saves every match played to the Replays list, from the next room joined. */
  saveMatches: boolean;

  keyBindings: KeyBindings;
  extrapolation: number;
  touchControlsEnabled: boolean;
  /** Joystick base diameter in CSS px. */
  joystickSize: number;
}

export type SettingKey = keyof Settings;

type Normalizer<T> = (raw: unknown) => T | undefined;

interface SettingSpec<T> {
  default: T;
  normalize: Normalizer<T>;
}

const bool: Normalizer<boolean> = (raw) => (typeof raw === 'boolean' ? raw : undefined);

function oneOf<T>(values: readonly T[]): Normalizer<T> {
  return (raw) => values.find((v) => v === raw);
}

function range(min: number, max: number, step: number): Normalizer<number> {
  return (raw) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    const clamped = Math.min(max, Math.max(min, raw));
    return Number((Math.round((clamped - min) / step) * step + min).toFixed(6));
  };
}

function text(maxLength: number): Normalizer<string> {
  return (raw) => (typeof raw === 'string' ? Array.from(raw).slice(0, maxLength).join('') : undefined);
}

const geo: Normalizer<Geo | null> = (raw) => {
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const { lat, lon, code } = raw as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lon !== 'number' || typeof code !== 'string') return undefined;
  if (!/^[a-z]{2}$/i.test(code)) return undefined;
  return { lat, lon, code: code.toLowerCase() };
};

const SCHEMA: { [K in SettingKey]: SettingSpec<Settings[K]> } = {
  nickname: { default: '', normalize: text(NICKNAME_MAX_LENGTH) },
  avatar: { default: '', normalize: text(AVATAR_MAX_LENGTH) },
  geo: { default: null, normalize: geo },

  soundEnabled: { default: true, normalize: bool },
  chatSoundEnabled: { default: true, normalize: bool },
  highlightSoundEnabled: { default: true, normalize: bool },
  crowdSoundEnabled: { default: true, normalize: bool },
  volume: { default: 1, normalize: range(0, 1, 0.01) },

  viewMode: { default: -1, normalize: oneOf(VIEW_MODES) },
  fpsLimit: { default: 0, normalize: oneOf([0, 30] as const) },
  resolutionScale: { default: 1, normalize: oneOf([1, 0.75, 0.5, 0.25] as const) },
  lowLatencyCanvas: { default: true, normalize: bool },
  teamColorsEnabled: { default: true, normalize: bool },
  chatIndicatorsEnabled: { default: true, normalize: bool },
  avatarsEnabled: { default: true, normalize: bool },
  chatOpacity: { default: 0.8, normalize: range(0.5, 1, 0.01) },
  chatHeight: { default: 120, normalize: range(40, 2000, 1) },
  chatFocusHeight: { default: 140, normalize: range(0, 400, 10) },
  chatBackgroundWidth: { default: 'compact', normalize: oneOf(['full', 'compact'] as const) },
  joinLeaveNotices: { default: true, normalize: bool },
  saveMatches: { default: true, normalize: bool },

  keyBindings: { default: DEFAULT_KEY_BINDINGS, normalize: normalizeKeyBindings },
  extrapolation: { default: 0, normalize: range(-200, 1000, 1) },
  touchControlsEnabled: { default: true, normalize: bool },
  joystickSize: { default: 120, normalize: range(80, 200, 10) },
};

const SETTING_KEYS = Object.keys(SCHEMA) as SettingKey[];
const STORAGE_PREFIX = 'golix.';

function readStored(storage: KeyValueStorage, key: SettingKey): unknown {
  try {
    const raw = storage.getItem(STORAGE_PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function defaultSettings(): Settings {
  const entries = SETTING_KEYS.map((key) => [key, SCHEMA[key].default]);
  return Object.fromEntries(entries) as Settings;
}

export function loadSettings(storage: KeyValueStorage): Settings {
  const entries = SETTING_KEYS.map((key) => {
    const stored = readStored(storage, key);
    return [key, (stored === undefined ? undefined : SCHEMA[key].normalize(stored)) ?? SCHEMA[key].default];
  });
  return Object.fromEntries(entries) as Settings;
}

/** Throws if the value cannot be coerced into the setting's type; out-of-range numbers are clamped. */
export function saveSetting<K extends SettingKey>(storage: KeyValueStorage, key: K, value: Settings[K]): Settings[K] {
  const normalized = (SCHEMA[key] as SettingSpec<Settings[K]>).normalize(value);
  if (normalized === undefined) throw new TypeError(`Invalid value for setting "${key}"`);
  try {
    storage.setItem(STORAGE_PREFIX + key, JSON.stringify(normalized));
  } catch {
    // Quota exceeded or storage disabled: the value still applies for this session.
  }
  return normalized;
}

export type SettingsListener = <K extends SettingKey>(key: K, value: Settings[K]) => void;

export interface SettingsStore {
  get<K extends SettingKey>(key: K): Settings[K];
  set<K extends SettingKey>(key: K, value: Settings[K]): void;
  subscribe(listener: SettingsListener): () => void;
}

const ACTION_KEYS_ADDED = `${STORAGE_PREFIX}actionKeysAdded`;

/** Bindings saved before action keys existed get the default action keys once, on the keys still free. */
function addActionKeys(storage: KeyValueStorage, values: Settings): void {
  try {
    if (storage.getItem(ACTION_KEYS_ADDED) !== null) return;
    storage.setItem(ACTION_KEYS_ADDED, '1');
  } catch {
    return;
  }
  const actions: readonly BindableAction[] = ACTION_KEY_ACTIONS;
  const bound = values.keyBindings;
  if (Object.values(bound).some((action) => actions.includes(action))) return;
  const added = Object.entries(DEFAULT_KEY_BINDINGS).filter(([code, action]) => actions.includes(action) && bound[code] === undefined);
  if (added.length > 0) values.keyBindings = saveSetting(storage, 'keyBindings', { ...bound, ...Object.fromEntries(added) });
}

export function createSettingsStore(storage: KeyValueStorage): SettingsStore {
  const values = loadSettings(storage);
  addActionKeys(storage, values);
  const listeners = new Set<SettingsListener>();
  return {
    get: (key) => values[key],
    set(key, value) {
      const normalized = saveSetting(storage, key, value);
      values[key] = normalized;
      for (const listener of listeners) listener(key, normalized);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
