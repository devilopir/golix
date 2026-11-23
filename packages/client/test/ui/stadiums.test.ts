// @vitest-environment happy-dom
import { defaultStadiums } from '@golix/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStadiumPicker, STADIUM_FILE_ACCEPT } from '../../src/ui/stadiumPicker.ts';
import { isDefaultStadium, StadiumStore, stadiumChecksum, stadiumName } from '../../src/ui/stadiums.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { click, findButton } from './fakes.ts';

const TINY = '{ name: "Tiny", width: 100, height: 50 }';

describe('StadiumStore', () => {
  it('adds, lists and removes stadiums under its own key', () => {
    const storage = new MemoryStorage();
    const store = new StadiumStore(storage);
    store.add({ name: 'A', source: '1' });
    store.add({ name: 'B', source: '2' });
    expect(new StadiumStore(storage).list().map((s) => s.name)).toEqual(['A', 'B']);
    store.remove(0);
    expect(store.list()).toEqual([{ name: 'B', source: '2' }]);
    expect([...storage.items.keys()]).toEqual(['golix.stadiums']);
  });

  it('survives corrupt storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('golix.stadiums', '{bad');
    expect(new StadiumStore(storage).list()).toEqual([]);
  });

  it('recognises built-ins and checksums sources', () => {
    expect(isDefaultStadium(defaultStadiums[3].source)).toBe(true);
    expect(isDefaultStadium(TINY)).toBe(false);
    expect(stadiumName(TINY)).toBe('Tiny');
    expect(stadiumChecksum(TINY)).toBe(stadiumChecksum(TINY));
    expect(stadiumChecksum(TINY)).not.toBe(stadiumChecksum(TINY + ' '));
  });
});

describe('stadium picker', () => {
  let host: HTMLElement;
  let store: StadiumStore;
  let onPick: ReturnType<typeof vi.fn<(source: string) => void>>;
  let download: ReturnType<typeof vi.fn<(filename: string, text: string) => void>>;
  const items = () => [...host.querySelectorAll<HTMLLIElement>('.dk-stadium-list li')];
  const item = (name: string) => items().find((li) => li.textContent === name)!;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    store = new StadiumStore(new MemoryStorage());
    store.add({ name: 'Tiny', source: TINY });
    onPick = vi.fn<(source: string) => void>();
    download = vi.fn<(filename: string, text: string) => void>();
    openStadiumPicker({ host, store, onPick, download });
  });

  afterEach(() => host.remove());

  it('lists built-ins, then stored stadiums marked custom', () => {
    expect(items().map((li) => li.textContent)).toEqual([...defaultStadiums.map((s) => s.name), 'Tiny']);
    expect(item('Tiny').classList.contains('custom')).toBe(true);
  });

  it('enables buttons by selection', () => {
    expect(findButton(host, 'Pick').disabled).toBe(true);
    expect(findButton(host, 'Export').disabled).toBe(true);
    expect(findButton(host, 'Delete').disabled).toBe(true);
    item(defaultStadiums[0].name).click();
    expect(findButton(host, 'Pick').disabled).toBe(false);
    expect(findButton(host, 'Export').disabled).toBe(false);
    expect(findButton(host, 'Delete').disabled).toBe(true);
    item('Tiny').click();
    expect(findButton(host, 'Delete').disabled).toBe(false);
  });

  it('picks with the button or a double click', () => {
    item(defaultStadiums[1].name).click();
    click(host, 'Pick');
    expect(onPick).toHaveBeenCalledWith(defaultStadiums[1].source);
    expect(host.querySelector('.dk-dialog')).toBeNull();
    openStadiumPicker({ host, store, onPick, download });
    item('Tiny').dispatchEvent(new MouseEvent('dblclick'));
    expect(onPick).toHaveBeenLastCalledWith(TINY);
  });

  it('exports the selected stadium as .hbs', () => {
    item('Tiny').click();
    click(host, 'Export');
    expect(download).toHaveBeenCalledWith('Tiny.hbs', TINY);
  });

  it('deletes stored stadiums', () => {
    item('Tiny').click();
    click(host, 'Delete');
    expect(store.list()).toEqual([]);
    expect(items().map((li) => li.textContent)).not.toContain('Tiny');
  });

  function load(text: string) {
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe(STADIUM_FILE_ACCEPT);
    Object.defineProperty(input, 'files', { value: [new File([text], 'x.hbs')], configurable: true });
    input.dispatchEvent(new Event('change'));
  }

  it('loads a valid file as the room stadium', async () => {
    load('{ name: "Loaded", width: 10, height: 10 }');
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith('{ name: "Loaded", width: 10, height: 10 }'));
  });

  it('reports parse errors without picking', async () => {
    load('{ name: ');
    await vi.waitFor(() => expect(host.querySelector<HTMLElement>('.dk-error')!.hidden).toBe(false));
    expect(host.querySelector('.dk-error')!.textContent).not.toBe('');
    expect(onPick).not.toHaveBeenCalled();
  });
});
