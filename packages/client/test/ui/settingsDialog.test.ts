// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keysForAction } from '../../src/input/bindings.ts';
import { createSettingsStore, type SettingsStore } from '../../src/settings/settings.ts';
import { openSettingsDialog } from '../../src/ui/settingsDialog.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { click, findButton } from './fakes.ts';

describe('settings dialog', () => {
  let host: HTMLElement;
  let storage: MemoryStorage;
  let settings: SettingsStore;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    storage = new MemoryStorage();
    settings = createSettingsStore(storage);
    openSettingsDialog(host, settings);
  });

  afterEach(() => host.remove());

  const field = (label: string) =>
    [...host.querySelectorAll('.dk-field')].find((f) => f.firstElementChild!.textContent === label)!.querySelector<HTMLInputElement & HTMLSelectElement>('input, select')!;
  const change = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('change'));
  };

  it('has the four tabs, Sound first', () => {
    expect([...host.querySelectorAll('.dk-tab')].map((t) => t.textContent)).toEqual(['Sound', 'Video', 'Input', 'Misc']);
    expect(findButton(host, 'Sound').classList.contains('on')).toBe(true);
  });

  it('sound toggles write the store', () => {
    click(host, 'Nick highlight sound enabled');
    click(host, 'Sounds enabled');
    expect(settings.get('highlightSoundEnabled')).toBe(false);
    expect(settings.get('soundEnabled')).toBe(false);
    expect(findButton(host, 'Sounds enabled').classList.contains('on')).toBe(false);
    expect(storage.items.get('golix.soundEnabled')).toBe('false');
  });

  it('video options write the store', () => {
    click(host, 'Video');
    const viewport = field('Viewport Mode:');
    expect([...viewport.options].map((o) => o.textContent)).toEqual([
      'Dynamic',
      'Restricted 840x410',
      'Full 1x Zoom',
      'Full 1.25x Zoom',
      'Full 1.5x Zoom',
      'Full 1.75x Zoom',
      'Full 2x Zoom',
      'Full 2.25x Zoom',
      'Full 2.5x Zoom',
    ]);
    change(viewport, '7');
    change(field('FPS Limit:'), '1');
    change(field('Resolution Scaling:'), '2');
    change(field('Chat opacity'), '0.6');
    change(field('Chat focus height'), '200');
    change(field('Chat background width:'), '0');
    click(host, 'Show player avatars');
    expect(settings.get('viewMode')).toBe(6);
    expect(settings.get('fpsLimit')).toBe(30);
    expect(settings.get('resolutionScale')).toBe(0.5);
    expect(settings.get('chatOpacity')).toBe(0.6);
    expect(settings.get('chatFocusHeight')).toBe(200);
    expect(settings.get('chatBackgroundWidth')).toBe('full');
    expect(settings.get('avatarsEnabled')).toBe(false);
  });

  it('rebinds keys with a press-a-key capture and removes them', () => {
    click(host, 'Input');
    const rows = () => [...host.querySelectorAll('.dk-binding')];
    expect(rows().map((r) => r.firstElementChild!.textContent)).toEqual(['Up', 'Down', 'Left', 'Right', 'Kick', 'ToggleChat', 'Action 1', 'Action 2', 'Action 3', 'Action 4', 'Action 5', 'Action 6']);
    host.querySelector<HTMLButtonElement>('[aria-label="Add key for ToggleChat"]')!.click();
    expect(host.textContent).toContain('Press a key');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', cancelable: true }));
    return Promise.resolve().then(() => {
      expect(keysForAction(settings.get('keyBindings'), 'toggleChat')).toEqual(['KeyT']);
      expect(host.querySelector('.dk-capture')).toBeNull();
      const kickRow = rows()[4];
      const space = [...kickRow.querySelectorAll('.dk-key')].find((k) => k.firstChild!.textContent === 'Space')!;
      space.querySelector('button')!.click();
      expect(keysForAction(settings.get('keyBindings'), 'kick')).not.toContain('Space');
    });
  });

  it('closes on Escape', () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    expect(host.querySelector('.dk-settings')).toBeNull();
  });

  it('binds Escape in the key capture instead of closing', async () => {
    click(host, 'Input');
    host.querySelector<HTMLButtonElement>('[aria-label="Add key for ToggleChat"]')!.click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(keysForAction(settings.get('keyBindings'), 'toggleChat')).toContain('Escape');
    expect(host.querySelector('.dk-capture')).toBeNull();
    expect(host.querySelector('.dk-settings')).not.toBeNull();
  });

  it('overrides the location with the center of the chosen country', () => {
    settings.set('geo', { lat: 41, lon: 29, code: 'tr' });
    click(host, 'Misc');
    expect(host.textContent).toContain('Detected location:  TR');
    click(host, 'Override location');
    const countries = [...host.querySelectorAll('.dk-country-list li')];
    expect(countries.length).toBeGreaterThan(240);
    expect(countries[0].textContent).toContain('Afghanistan');
    expect(findButton(host, 'Change').disabled).toBe(true);
    countries.find((c) => c.textContent!.endsWith('Germany'))!.dispatchEvent(new MouseEvent('click'));
    click(host, 'Change');
    expect(settings.get('geo')).toEqual({ lat: 51, lon: 9, code: 'de' });
    expect(host.textContent).toContain('Detected location:  DE');
  });
});
