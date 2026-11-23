// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore, type SettingsStore } from '../../src/settings/settings.ts';
import { openCreateRoomDialog } from '../../src/ui/createRoom.ts';
import { isValidNickname, openNicknameDialog } from '../../src/ui/nickname.ts';
import { RoomListScreen, visibleRooms, type RoomListEntry } from '../../src/ui/roomList.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { click, findButton } from './fakes.ts';

let host: HTMLElement;
let settings: SettingsStore;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  settings = createSettingsStore(new MemoryStorage());
});

afterEach(() => host.remove());

describe('nickname dialog', () => {
  it('validates like the original: only empty is rejected', () => {
    expect(isValidNickname('')).toBe(false);
    expect(isValidNickname('   ')).toBe(true);
    expect(isValidNickname('a'.repeat(25))).toBe(true);
    expect(isValidNickname('a'.repeat(26))).toBe(false);
  });

  it('prefills the stored nick, disables Ok when empty and saves on Ok', () => {
    settings.set('nickname', 'dktest');
    const done = vi.fn();
    openNicknameDialog(host, settings, done);
    expect(host.querySelector('h2')!.textContent).toBe('Choose nickname');
    const input = host.querySelector('input')!;
    expect(input.value).toBe('dktest');
    expect(input.maxLength).toBe(25);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(findButton(host, 'Ok').disabled).toBe(true);
    input.value = 'newnick';
    input.dispatchEvent(new Event('input'));
    const letter = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    input.dispatchEvent(letter);
    expect(letter.defaultPrevented).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(settings.get('nickname')).toBe('newnick');
    expect(done).toHaveBeenCalledOnce();
    expect(host.querySelector('.dk-dialog')).toBeNull();
  });
});

describe('create room dialog', () => {
  it('uses the observed defaults and limits', () => {
    const onCreate = vi.fn();
    openCreateRoomDialog(host, 'dktest', onCreate);
    const [name, password] = host.querySelectorAll('input');
    const maxPlayers = host.querySelector('select')!;
    expect(name.value).toBe("dktest's room");
    expect(name.maxLength).toBe(40);
    expect(password.maxLength).toBe(30);
    expect([...maxPlayers.options].map((o) => o.textContent)).toEqual(Array.from({ length: 19 }, (_, i) => String(i + 2)));
    expect(maxPlayers.selectedOptions[0].textContent).toBe('12');
    click(host, 'Show in room list: Yes');
    password.value = 'pw';
    maxPlayers.value = '0';
    maxPlayers.dispatchEvent(new Event('change'));
    click(host, 'Create');
    expect(onCreate).toHaveBeenCalledWith({ name: "dktest's room", password: 'pw', maxPlayers: 2, public: false });
  });
});

describe('room list', () => {
  const rooms: RoomListEntry[] = [
    { id: 'far', name: 'Far', players: 3, maxPlayers: 10, hasPassword: false, captcha: false, actionKeys: false, country: 'br', lat: -23, lon: -46 },
    { id: 'near', name: 'Near', players: 0, maxPlayers: 10, hasPassword: false, captcha: false, actionKeys: false, country: 'tr', lat: 41, lon: 29 },
    { id: 'locked', name: 'Locked', players: 2, maxPlayers: 10, hasPassword: true, captcha: true, actionKeys: true, country: 'de', lat: 52, lon: 13 },
    { id: 'full', name: 'Full', players: 4, maxPlayers: 4, hasPassword: false, captcha: false, actionKeys: false, country: 'gb', lat: 51, lon: 0 },
  ];
  const geo = { lat: 41, lon: 29, code: 'tr' };

  it('sorts by distance and filters locked, full and empty rooms', () => {
    const all = { locked: true, full: true, empty: true };
    expect(visibleRooms(rooms, all, geo).map((r) => r.id)).toEqual(['near', 'locked', 'full', 'far']);
    expect(visibleRooms(rooms, { ...all, locked: false }, geo).map((r) => r.id)).toEqual(['near', 'full', 'far']);
    expect(visibleRooms(rooms, { ...all, full: false }, geo).map((r) => r.id)).toEqual(['near', 'locked', 'far']);
    expect(visibleRooms(rooms, { ...all, empty: false }, geo).map((r) => r.id)).toEqual(['locked', 'full', 'far']);
  });

  it('renders the list, selects rows and asks for a password on locked rooms', async () => {
    settings.set('geo', geo);
    const actions = { join: vi.fn(), create: vi.fn(), replays: vi.fn(), settings: vi.fn(), changeNick: vi.fn() };
    const screen = new RoomListScreen(host, { list: async () => rooms, lobby: async () => ({ country: 'de', notice: '', captchaSiteKey: '' }) }, settings, actions);
    host.append(screen.el);
    await screen.refresh();
    expect(screen.el.querySelector('.dk-room-count')!.textContent).toBe('9 players in 4 rooms');
    const rows = () => [...screen.el.querySelectorAll('tbody tr')];
    expect([...rows()[1].children].map((c) => c.textContent)).toEqual(['CaptchaAction keysLocked', '2/10', 'Yes', expect.stringMatching(/^🇩🇪\d+km$/u)]);
    expect([...rows()[1].querySelectorAll('.dk-room-badge')].map((b) => b.textContent)).toEqual(['Captcha', 'Action keys']);
    expect(rows()[0].querySelector('.dk-room-badge')).toBeNull();
    expect(findButton(screen.el, 'Join Room').disabled).toBe(true);
    rows()[0].dispatchEvent(new MouseEvent('click'));
    click(screen.el, 'Join Room');
    expect(actions.join).toHaveBeenCalledWith(rooms[1], '');
    rows()[1].dispatchEvent(new MouseEvent('dblclick'));
    host.querySelector<HTMLInputElement>('.dk-dialog input')!.value = 'secret';
    click(host, 'Ok');
    expect(actions.join).toHaveBeenLastCalledWith(rooms[2], 'secret');
    click(screen.el, 'Show locked');
    expect(rows().map((r) => r.firstElementChild!.textContent)).toEqual(['Near', 'Full', 'Far']);
    click(screen.el, 'Replays');
    expect(actions.replays).toHaveBeenCalledOnce();
    click(screen.el, 'Change Nick');
    expect(actions.changeNick).toHaveBeenCalled();
  });

  const actions = () => ({ join: vi.fn(), create: vi.fn(), replays: vi.fn(), settings: vi.fn(), changeNick: vi.fn() });

  it('starts from the center of the country the lobby reports when no location is saved', async () => {
    const screen = new RoomListScreen(host, { list: async () => rooms, lobby: async () => ({ country: 'tr', notice: '', captchaSiteKey: '' }) }, settings, actions());
    await screen.refresh();
    expect(settings.get('geo')).toEqual({ lat: 39, lon: 35, code: 'tr' });
    settings.set('geo', { lat: 51, lon: 9, code: 'de' });
    await screen.refresh();
    expect(settings.get('geo')).toEqual({ lat: 51, lon: 9, code: 'de' });
  });

  it('keeps no location when the lobby does not know the country', async () => {
    const screen = new RoomListScreen(host, { list: async () => rooms, lobby: async () => ({ country: '', notice: '', captchaSiteKey: '' }) }, settings, actions());
    await screen.refresh();
    expect(settings.get('geo')).toBeNull();
  });

  it('shows the server notice until it is closed and hides an empty one', async () => {
    let notice = 'Maintenance at 22:00';
    const screen = new RoomListScreen(host, { list: async () => rooms, lobby: async () => ({ country: '', notice, captchaSiteKey: '' }) }, settings, actions());
    const area = () => screen.el.querySelector<HTMLElement>('.dk-room-notice')!;
    expect(area().hidden).toBe(true);
    await screen.refresh();
    expect(area().hidden).toBe(false);
    expect(area().textContent).toContain('Maintenance at 22:00');
    area().querySelector('button')!.click();
    expect(area().hidden).toBe(true);
    await screen.refresh();
    expect(area().hidden).toBe(true);
    notice = 'Back online';
    await screen.refresh();
    expect(area().hidden).toBe(false);
    notice = '';
    await screen.refresh();
    expect(area().hidden).toBe(true);
  });

  it('shows a loading indicator while refreshing and an error when the lobby is unreachable', async () => {
    let fail = false;
    let release = () => {};
    const source = {
      list: () => new Promise<RoomListEntry[]>((resolve, reject) => (release = () => (fail ? reject(new Error('offline')) : resolve(rooms)))),
      lobby: async () => ({ country: '', notice: '', captchaSiteKey: '' }),
    };
    const screen = new RoomListScreen(host, source, settings, actions());
    const status = () => screen.el.querySelector<HTMLElement>('.dk-room-status')!;
    const pending = screen.refresh();
    expect(status().hidden).toBe(false);
    expect(status().textContent).toBe('Loading rooms...');
    expect(findButton(screen.el, 'Refresh').disabled).toBe(true);
    release();
    await pending;
    expect(status().hidden).toBe(true);
    expect(screen.el.querySelectorAll('tbody tr')).toHaveLength(4);

    fail = true;
    const failing = screen.refresh();
    release();
    await failing;
    expect(status().hidden).toBe(false);
    expect(status().getAttribute('role')).toBe('alert');
    expect(status().textContent).toBe('Could not reach the server. Check your connection and press Refresh.');
    expect(findButton(screen.el, 'Refresh').disabled).toBe(false);
    expect(screen.el.querySelectorAll('tbody tr')).toHaveLength(4);
  });
});
