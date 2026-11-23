import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEY_BINDINGS } from '../../src/input/bindings.ts';
import { createSettingsStore, defaultSettings, loadSettings, saveSetting } from '../../src/settings/settings.ts';
import { MemoryStorage } from './memoryStorage.ts';

describe('settings', () => {
  it('loads observed defaults from empty storage', () => {
    const settings = loadSettings(new MemoryStorage());
    expect(settings).toEqual(defaultSettings());
    expect(settings).toMatchObject({
      soundEnabled: true,
      chatSoundEnabled: true,
      highlightSoundEnabled: true,
      crowdSoundEnabled: true,
      viewMode: -1,
      fpsLimit: 0,
      resolutionScale: 1,
      lowLatencyCanvas: true,
      teamColorsEnabled: true,
      chatIndicatorsEnabled: true,
      avatarsEnabled: true,
      chatOpacity: 0.8,
      chatFocusHeight: 140,
      chatBackgroundWidth: 'compact',
      extrapolation: 0,
      geo: null,
      keyBindings: DEFAULT_KEY_BINDINGS,
    });
  });

  it('persists every change immediately and reloads it', () => {
    const storage = new MemoryStorage();
    saveSetting(storage, 'viewMode', 6);
    saveSetting(storage, 'crowdSoundEnabled', false);
    saveSetting(storage, 'geo', { lat: 41, lon: 29, code: 'TR' });
    expect(loadSettings(storage)).toMatchObject({
      viewMode: 6,
      crowdSoundEnabled: false,
      geo: { lat: 41, lon: 29, code: 'tr' },
    });
  });

  it('clamps numbers to range and step', () => {
    const storage = new MemoryStorage();
    expect(saveSetting(storage, 'chatOpacity', 0.2)).toBe(0.5);
    expect(saveSetting(storage, 'chatOpacity', 0.834)).toBe(0.83);
    expect(saveSetting(storage, 'chatFocusHeight', 999)).toBe(400);
    expect(saveSetting(storage, 'chatFocusHeight', 144)).toBe(140);
    expect(saveSetting(storage, 'extrapolation', 5000)).toBe(1000);
    expect(saveSetting(storage, 'extrapolation', -300)).toBe(-200);
    expect(saveSetting(storage, 'extrapolation', 12.6)).toBe(13);
    expect(saveSetting(storage, 'volume', 2)).toBe(1);
  });

  it('truncates nickname to 25 and avatar to 2 characters', () => {
    const storage = new MemoryStorage();
    expect(saveSetting(storage, 'nickname', 'x'.repeat(40))).toHaveLength(25);
    expect(saveSetting(storage, 'nickname', '   ')).toBe('   ');
    expect(saveSetting(storage, 'avatar', '⚽⚽⚽')).toBe('⚽⚽');
  });

  it('rejects values of the wrong type', () => {
    expect(() => saveSetting(new MemoryStorage(), 'fpsLimit', 60 as 30)).toThrow(TypeError);
  });

  it('falls back to defaults for corrupt or invalid stored values', () => {
    const storage = new MemoryStorage();
    storage.setItem('golix.viewMode', '{not json');
    storage.setItem('golix.soundEnabled', '"yes"');
    storage.setItem('golix.resolutionScale', '0.6');
    storage.setItem('golix.geo', '{"lat":1,"lon":2,"code":"turkey"}');
    storage.setItem('golix.keyBindings', '[1,2]');
    storage.setItem('golix.chatOpacity', '7');
    const settings = loadSettings(storage);
    expect(settings.viewMode).toBe(-1);
    expect(settings.soundEnabled).toBe(true);
    expect(settings.resolutionScale).toBe(1);
    expect(settings.geo).toBeNull();
    expect(settings.keyBindings).toEqual(DEFAULT_KEY_BINDINGS);
    expect(settings.chatOpacity).toBe(1);
  });

  it('drops unknown actions from stored bindings but keeps an empty map', () => {
    const storage = new MemoryStorage();
    storage.setItem('golix.keyBindings', '{"KeyQ":"kick","KeyZ":"fly"}');
    expect(loadSettings(storage).keyBindings).toEqual({ KeyQ: 'kick' });
    storage.setItem('golix.keyBindings', '{}');
    expect(loadSettings(storage).keyBindings).toEqual({});
  });

  it('survives storage that throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const store = createSettingsStore(storage);
    expect(store.get('chatFocusHeight')).toBe(140);
    store.set('chatFocusHeight', 200);
    expect(store.get('chatFocusHeight')).toBe(200);
  });

  it('notifies subscribers with the normalized value until unsubscribed', () => {
    const store = createSettingsStore(new MemoryStorage());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set('chatFocusHeight', 1000);
    expect(listener).toHaveBeenCalledWith('chatFocusHeight', 400);
    expect(store.get('chatFocusHeight')).toBe(400);
    unsubscribe();
    store.set('soundEnabled', false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('adds the default action keys once to bindings saved before they existed, on free keys only', () => {
    const storage = new MemoryStorage();
    storage.setItem('golix.keyBindings', '{"KeyE":"kick","ArrowUp":"up"}');
    const store = createSettingsStore(storage);
    const expected = { KeyE: 'kick', ArrowUp: 'up', KeyQ: 'action1', KeyR: 'action3', KeyF: 'action4', KeyC: 'action5', KeyV: 'action6' };
    expect(store.get('keyBindings')).toEqual(expected);
    expect(JSON.parse(storage.getItem('golix.keyBindings')!)).toEqual(expected);
    store.set('keyBindings', { KeyE: 'kick', ArrowUp: 'up' });
    expect(createSettingsStore(storage).get('keyBindings')).toEqual({ KeyE: 'kick', ArrowUp: 'up' });
  });

  it('leaves bindings that already have an action key or were never saved', () => {
    const storage = new MemoryStorage();
    storage.setItem('golix.keyBindings', '{"KeyZ":"action2"}');
    expect(createSettingsStore(storage).get('keyBindings')).toEqual({ KeyZ: 'action2' });
    const fresh = new MemoryStorage();
    expect(createSettingsStore(fresh).get('keyBindings')).toEqual(DEFAULT_KEY_BINDINGS);
    expect(fresh.items.has('golix.keyBindings')).toBe(false);
  });
});
