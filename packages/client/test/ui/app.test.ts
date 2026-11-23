// @vitest-environment happy-dom
import { Team } from '@golix/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore, type SettingsStore } from '../../src/settings/settings.ts';
import { defaultTheme } from '../../src/theme/index.ts';
import { App } from '../../src/ui/app.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { click, FakeSession, findButton, game, player, room } from './fakes.ts';

describe('App in a room', () => {
  let root: HTMLElement;
  let settings: SettingsStore;
  let session: FakeSession;

  const press = (code: string, key = code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key, cancelable: true }));
  const overlay = () => root.querySelector<HTMLElement>('.dk-room-overlay')!;
  const chatLines = () => [...root.querySelectorAll('.dk-chat-line')].map((l) => l.textContent);

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    const storage = new MemoryStorage();
    settings = createSettingsStore(storage);
    settings.set('extrapolation', 300);
    session = new FakeSession(room([player(1, 'dktest', { admin: true }), player(2, 'mira')]));
    const app = new App({
      root,
      settings,
      storage,
      theme: defaultTheme,
      rooms: { list: async () => [], lobby: async () => ({ country: '', notice: '', captchaSiteKey: '' }) },
      join: vi.fn(),
      create: vi.fn(),
      roomLink: () => 'link',
      playSound: () => {},
      setRecording: () => {},
      setHandicap: () => {},
    });
    app.enterRoom(session);
  });

  afterEach(() => {
    if (root.querySelector('.dk-room-screen') !== null) {
      click(root, 'Leave');
      click(root.querySelector('.dk-dialog')!, 'Leave');
    }
    root.remove();
  });

  it('greets with the controls and the extrapolation', () => {
    expect(chatLines()).toEqual(['Controls:', 'Move: WASD or Arrows', 'Kick: X, Space, Ctrl, Shift, Numpad 0', 'View: Numbers 1 to 4', 'Extrapolation set to 300 msec']);
    expect(root.style.getPropertyValue('--dk-red')).toBe('#f0563c');
  });

  it('shows the room screen between matches and toggles it with Escape during one', () => {
    expect(overlay().hidden).toBe(false);
    press('Escape');
    expect(overlay().hidden).toBe(false);
    session.state.game = game();
    session.emit({ type: 'startGame', byPlayer: 1 });
    expect(overlay().hidden).toBe(true);
    press('Escape');
    expect(overlay().hidden).toBe(false);
    click(root, 'Menu');
    expect(overlay().hidden).toBe(true);
    session.state.game = null;
    session.emit({ type: 'stopGame', byPlayer: 1 });
    expect(overlay().hidden).toBe(false);
  });

  it('Escape closes an open dialog without toggling the room menu', () => {
    session.state.game = game();
    session.emit({ type: 'startGame', byPlayer: 1 });
    click(root, 'Settings');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
    expect(root.querySelector('.dk-settings')).toBeNull();
    expect(overlay().hidden).toBe(true);
  });

  it('sends movement, but not while typing in chat', () => {
    press('ArrowRight');
    expect(session.inputs).toEqual([8]);
    press('Enter');
    const input = root.querySelector<HTMLInputElement>('.dk-chat-input')!;
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }));
    expect(session.inputs).toEqual([8, 0]);
  });

  it('pauses with P for admins during a match', () => {
    press('KeyP');
    expect(session.requests().filter((e) => e.type === 'setPaused')).toEqual([]);
    session.state.game = game();
    press('KeyP');
    expect(session.requests().filter((e) => e.type === 'setPaused')).toEqual([{ type: 'setPaused', paused: true, byPlayer: 1 }]);
  });

  it('maps number keys 1-7 to fixed zoom modes and ignores 0', () => {
    press('Digit3');
    expect(settings.get('viewMode')).toBe(3);
    press('Digit7');
    expect(settings.get('viewMode')).toBe(7);
    press('Digit0');
    expect(settings.get('viewMode')).toBe(7);
  });

  it('announces the winner and shows the room screen once a finished match stops', () => {
    session.state.game = game();
    session.emit({ type: 'startGame', byPlayer: 1 });
    session.tick([{ type: 'goal', team: 2 }, { type: 'victory', team: 2 }]);
    expect(chatLines().at(-1)).toBe('Blue team won the match');
    expect(overlay().hidden).toBe(true);
    session.state.game = null;
    session.tick([{ type: 'gameStop' }]);
    expect(overlay().hidden).toBe(false);
    expect(findButton(root, 'Start game').hidden).toBe(false);
  });

  it('returns to the room list when kicked', () => {
    session.emit({ type: 'playerLeave', playerId: 1, kicked: true, ban: false, reason: 'afk', byPlayer: 2 });
    expect(root.querySelector('.dk-room-list')).not.toBeNull();
    expect(root.textContent).toContain('You were kicked by mira (afk)');
  });

  it('names the banning player', () => {
    session.emit({ type: 'playerLeave', playerId: 1, kicked: true, ban: true, reason: '', byPlayer: 2 });
    expect(root.textContent).toContain('You were banned by mira');
  });

  it('leaves the name out when the host kicks', () => {
    session.emit({ type: 'playerLeave', playerId: 1, kicked: true, ban: false, reason: 'afk', byPlayer: null });
    expect(root.textContent).toContain('You were kicked (afk)');
  });

  it('shows why the connection dropped and returns to the room list on Ok', () => {
    session.close('timeout');
    expect(root.querySelector('.dk-room-list')).not.toBeNull();
    const dialog = root.querySelector('.dk-dialog')!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Disconnected');
    expect(dialog.querySelector('p')!.textContent).toBe('Connection timed out');
    click(dialog, 'Ok');
    expect(root.querySelector('.dk-dialog')).toBeNull();
    expect(root.querySelector('.dk-room-list')).not.toBeNull();
  });

  it('falls back to a generic text for a dropped connection', () => {
    session.close('closed');
    expect(root.querySelector('.dk-dialog p')!.textContent).toBe('Connection closed');
  });

  it('leaves without a disconnect dialog', () => {
    click(root, 'Leave');
    click(root.querySelector('.dk-dialog')!, 'Leave');
    expect(session.left).toBe(true);
    expect(root.querySelector('.dk-room-list')).not.toBeNull();
    expect(root.querySelector('.dk-dialog')).toBeNull();
  });

  it('refreshes the room screen and overlay as soon as a snapshot arrives', () => {
    session.resync(room([player(1, 'dktest', { admin: true }), player(3, 'nova')]));
    expect(root.querySelector('.dk-room-screen')!.textContent).toContain('nova');
    expect(root.querySelector('.dk-room-screen')!.textContent).not.toContain('mira');
    session.resync(room([player(1, 'dktest', { admin: true })], { game: game() }));
    expect(overlay().hidden).toBe(true);
  });

  describe('touch controls', () => {
    const controls = () => root.querySelector<HTMLElement>('.dk-touch')!;
    const touchPointer = (target: Element, type: string, pointerId: number) =>
      target.dispatchEvent(new PointerEvent(type, { pointerId, pointerType: 'touch', bubbles: true, cancelable: true }));
    const startMatch = () => {
      session.state.players[0].team = Team.red;
      session.state.game = game();
      session.emit({ type: 'startGame', byPlayer: 1 });
    };

    it('show only on a touch device, for a player on the pitch during a match', () => {
      startMatch();
      expect(controls().hidden).toBe(true);
      window.dispatchEvent(new Event('touchstart'));
      expect(controls().hidden).toBe(false);
      session.state.players[0].team = Team.spectators;
      session.emit({ type: 'setTeam', playerId: 1, team: Team.spectators, byPlayer: 1, announce: true });
      expect(controls().hidden).toBe(true);
      session.state.players[0].team = Team.blue;
      session.emit({ type: 'setTeam', playerId: 1, team: Team.blue, byPlayer: 1, announce: true });
      expect(controls().hidden).toBe(false);
      session.state.game = null;
      session.emit({ type: 'stopGame', byPlayer: 1 });
      expect(controls().hidden).toBe(true);
    });

    it('hide while chat or the room menu is open, and when turned off', () => {
      window.dispatchEvent(new Event('touchstart'));
      startMatch();
      press('Enter');
      expect(controls().hidden).toBe(true);
      root.querySelector<HTMLInputElement>('.dk-chat-input')!.blur();
      expect(controls().hidden).toBe(false);
      press('Escape');
      expect(controls().hidden).toBe(true);
      press('Escape');
      expect(controls().hidden).toBe(false);
      settings.set('touchControlsEnabled', false);
      expect(controls().hidden).toBe(true);
      settings.set('touchControlsEnabled', true);
      settings.set('joystickSize', 160);
      expect(controls().style.getPropertyValue('--dk-stick-size')).toBe('160px');
    });

    it('merge with the keyboard into one input stream', () => {
      window.dispatchEvent(new Event('touchstart'));
      startMatch();
      const kickButton = root.querySelector('.dk-touch-kick')!;
      press('ArrowUp');
      touchPointer(kickButton, 'pointerdown', 7);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp' }));
      press('KeyX');
      touchPointer(kickButton, 'pointerup', 7);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX' }));
      expect(session.inputs).toEqual([1, 17, 16, 0]);
    });
  });
});

describe('App started from a room link', () => {
  it('asks for the nickname, then the password of a locked room, then joins it', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const join = vi.fn(() => new Promise<never>(() => {}));
    const app = new App({
      root,
      settings: createSettingsStore(new MemoryStorage()),
      storage: new MemoryStorage(),
      theme: defaultTheme,
      rooms: { list: async () => [], lobby: async () => ({ country: '', notice: '', captchaSiteKey: '' }) },
      join,
      create: vi.fn(),
      roomLink: () => 'link',
      playSound: () => {},
      setRecording: () => {},
      setHandicap: () => {},
    });
    const link = { id: 'AbCdEfGh_-1', name: 'AbCdEfGh_-1', players: 0, maxPlayers: 0, hasPassword: true, captcha: false, actionKeys: false, country: '', lat: 0, lon: 0 };
    app.start(link);
    const nick = root.querySelector<HTMLInputElement>('.dk-nickname input')!;
    nick.value = 'dktest';
    nick.dispatchEvent(new Event('input'));
    click(root, 'Ok');
    expect(root.querySelector('.dk-dialog h2')!.textContent).toBe('Room password');
    root.querySelector<HTMLInputElement>('.dk-dialog input')!.value = 'secret';
    click(root, 'Ok');
    expect(join).toHaveBeenCalledWith(link, 'secret');
    root.remove();
  });
});

describe('App joining from the room list', () => {
  it('starts only one connection when a room is double-clicked twice', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const settings = createSettingsStore(new MemoryStorage());
    settings.set('nickname', 'dktest');
    const join = vi.fn(() => new Promise<never>(() => {}));
    const entry = { id: 'AbCdEfGh_-1', name: 'Open room', players: 1, maxPlayers: 12, hasPassword: false, captcha: false, actionKeys: false, country: '', lat: 0, lon: 0 };
    new App({
      root,
      settings,
      storage: new MemoryStorage(),
      theme: defaultTheme,
      rooms: { list: async () => [entry], lobby: async () => ({ country: '', notice: '', captchaSiteKey: '' }) },
      join,
      create: vi.fn(),
      roomLink: () => 'link',
      playSound: () => {},
      setRecording: () => {},
      setHandicap: () => {},
    }).start();
    click(root, 'Ok');
    await vi.waitFor(() => expect(root.querySelector('tbody tr')).not.toBeNull());
    const row = root.querySelector('tbody tr')!;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    click(root, 'Join Room');
    expect(join).toHaveBeenCalledOnce();
    expect(root.querySelector('.dk-connecting')!.textContent).toContain('Connecting to the room...');
    root.remove();
  });

  it('closes the connecting dialog when the join fails', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const settings = createSettingsStore(new MemoryStorage());
    settings.set('nickname', 'dktest');
    const entry = { id: 'AbCdEfGh_-1', name: 'Open room', players: 1, maxPlayers: 12, hasPassword: false, captcha: false, actionKeys: false, country: '', lat: 0, lon: 0 };
    new App({
      root,
      settings,
      storage: new MemoryStorage(),
      theme: defaultTheme,
      rooms: { list: async () => [entry], lobby: async () => ({ country: '', notice: '', captchaSiteKey: '' }) },
      join: () => Promise.reject(new Error('The room is full.')),
      create: vi.fn(),
      roomLink: () => 'link',
      playSound: () => {},
      setRecording: () => {},
      setHandicap: () => {},
    }).start();
    click(root, 'Ok');
    await vi.waitFor(() => expect(root.querySelector('tbody tr')).not.toBeNull());
    root.querySelector('tbody tr')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector('.dk-dialog h2')?.textContent).toBe('Disconnected'));
    expect(root.querySelector('.dk-connecting')).toBeNull();
    root.remove();
  });
});
