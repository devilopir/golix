// @vitest-environment happy-dom
import { ReplayError, decodeReplay, encodeReplay } from '@golix/replay';
import { Team, applyEvent, createRoomState, stepRoom, type RoomEvent, type RoomState, type TickOutcome } from '@golix/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordMatches, recordSession, replayFileName } from '../../src/net/recording.ts';
import type { RenderFrame, Renderer } from '../../src/render/index.ts';
import type { RoomSession } from '../../src/session.ts';
import { createSettingsStore } from '../../src/settings/settings.ts';
import { defaultTheme } from '../../src/theme/index.ts';
import { App } from '../../src/ui/app.ts';
import { ReplayViewer, fetchReplay, parseClock, replayLink, replayPageLink } from '../../src/ui/replayViewer.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { click } from './fakes.ts';

/** Applies and steps every tick like the confirmed side of a NetSession. */
class ServerLikeSession implements RoomSession {
  readonly playerId = 1;
  readonly room: RoomState = createRoomState({ name: 'Friday: 3v3', maxPlayers: 12, hasPassword: false });
  private serverTick = 100;
  private readonly listeners = new Set<(ev: RoomEvent) => void>();
  private readonly tickListeners = new Set<(tick: number, outcomes: readonly TickOutcome[]) => void>();

  getRoom(): RoomState {
    return this.room;
  }

  send(): void {}

  sendInput(): void {}

  onEvent(cb: (ev: RoomEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onTick(cb: (tick: number, outcomes: readonly TickOutcome[]) => void): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  onResync(): () => void {
    return () => {};
  }

  onClose(): () => void {
    return () => {};
  }

  leave(): void {}

  tick(events: RoomEvent[] = []): void {
    const outcomes = events.flatMap((ev) => applyEvent(this.room, ev));
    outcomes.push(...stepRoom(this.room));
    this.serverTick++;
    for (const ev of events) for (const cb of this.listeners) cb(ev);
    for (const cb of this.tickListeners) cb(this.serverTick, outcomes);
  }
}

function join(id: number, name: string): RoomEvent {
  return { type: 'playerJoin', player: { id, name, team: Team.spectators, admin: id === 1, avatar: '', country: 'tr', joinSeq: id, ping: 0 } };
}

function recordedMatch() {
  const session = new ServerLikeSession();
  session.tick([join(1, 'dktest')]);
  let handicap = 0;
  const stop = recordSession(session, () => handicap);
  session.tick([join(2, 'mira'), { type: 'chat', playerId: 1, text: 'before kickoff' }]);
  session.tick([
    { type: 'setTeam', playerId: 1, team: Team.red, byPlayer: 1, announce: true },
    { type: 'setTeam', playerId: 2, team: Team.blue, byPlayer: 1, announce: true },
    { type: 'startGame', byPlayer: 1 },
  ]);
  for (let i = 0; i < 100; i++) session.tick();
  handicap = 40;
  session.tick([{ type: 'ping', pings: [[1, 32], [2, 84]] }]);
  for (let i = 0; i < 99; i++) session.tick();
  session.tick([{ type: 'chat', playerId: 2, text: 'hello' }]);
  for (let i = 0; i < 97; i++) session.tick();
  const bytes = stop();
  session.tick([{ type: 'chat', playerId: 2, text: 'after the recording' }]);
  return { session, replay: decodeReplay(bytes) };
}

describe('recording', () => {
  it('stores every confirmed tick from the moment Rec is pressed', () => {
    const { replay } = recordedMatch();
    expect(replay.start.players.map((p) => p.name)).toEqual(['dktest']);
    expect(replay.frames).toHaveLength(300);
    expect(replay.frames[0]).toEqual({ kind: 'events', events: [join(2, 'mira'), { type: 'chat', playerId: 1, text: 'before kickoff' }] });
    expect(replay.frames.filter((f) => f.kind === 'events' && f.events.length > 0)).toHaveLength(4);
    expect(replay.handicaps).toEqual([{ frame: 102, playerId: 1, ms: 40 }]);
  });

  it('saves each game from its first tick to its last on its own, and a game still running when stopped', async () => {
    const session = new ServerLikeSession();
    session.tick([join(1, 'dktest'), { type: 'setTeam', playerId: 1, team: Team.red, byPlayer: 1, announce: false }]);
    const saved: { frames: number; ticks: number; game: boolean }[] = [];
    const stop = recordMatches(session, () => 0, (data, ticks) => {
      const replay = decodeReplay(data);
      saved.push({ frames: replay.frames.length, ticks, game: replay.start.game !== null });
    });
    session.tick();
    session.tick([{ type: 'startGame', byPlayer: 1 }]);
    await Promise.resolve();
    for (let i = 0; i < 50; i++) session.tick();
    session.tick([{ type: 'stopGame', byPlayer: 1 }]);
    await Promise.resolve();
    session.tick();
    expect(saved).toEqual([{ frames: 51, ticks: 51, game: true }]);

    session.tick([{ type: 'startGame', byPlayer: 1 }]);
    await Promise.resolve();
    for (let i = 0; i < 10; i++) session.tick();
    stop();
    session.tick([{ type: 'stopGame', byPlayer: 1 }]);
    await Promise.resolve();
    expect(saved.at(-1)).toEqual({ frames: 10, ticks: 10, game: true });
    expect(saved).toHaveLength(2);
  });

  it('names the file after the date and the room', () => {
    expect(replayFileName('Friday: 3v3 / fun', new Date(2026, 10, 9, 7, 5))).toBe('2026-11-09-07h05m Friday_ 3v3 _ fun.glx');
  });
});

describe('ReplayViewer', () => {
  let root: HTMLElement;
  let viewer: ReplayViewer;
  let frames: RenderFrame[];
  let onLeave: () => void;
  const sounds: string[] = [];
  const download = vi.fn<(name: string, data: Uint8Array<ArrayBuffer>) => void>();

  const chat = () => [...root.querySelectorAll('.dk-chat-line')].map((l) => l.textContent);
  const clock = () => root.querySelector('.dk-replay-clock')!.textContent;
  let now = 0;
  const run = (ms: number) => {
    for (const end = now + ms; now < end; ) viewer.update((now = Math.min(now + 100, end)));
  };
  const cameraSelect = () => root.querySelector<HTMLSelectElement>('select[aria-label="Camera"]')!;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    frames = [];
    now = 0;
    sounds.length = 0;
    onLeave = vi.fn();
    const renderer: Renderer = { render: (frame) => frames.push(frame), resize: () => {} };
    viewer = new ReplayViewer({
      replay: recordedMatch().replay,
      settings: createSettingsStore(new MemoryStorage()),
      createRenderer: () => renderer,
      playSound: (name) => sounds.push(name),
      download,
      onLeave,
    });
    root.append(viewer.el);
  });

  afterEach(() => {
    viewer.dispose();
    root.remove();
  });

  it('plays at the chosen speed and shows chat as it happened', () => {
    viewer.update(0);
    expect(clock()).toBe('00:00 / 00:05');
    expect(root.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true);
    expect(chat()).toEqual([]);

    click(root, 'Play');
    expect(root.textContent).toContain('Pause');
    run(1000);
    expect(clock()).toBe('00:01 / 00:05');
    expect(chat()).toEqual(['mira has joined', 'dktest: before kickoff', 'dktest was moved to Red by dktest', 'mira was moved to Blue by dktest', 'Game started by dktest']);
    expect(frames.at(-1)!.curr.players.map((p) => p.id)).toEqual([1, 2]);
    expect(frames.at(-1)!.localPlayerId).toBeNull();

    const speed = root.querySelector<HTMLSelectElement>('select[aria-label="Speed"]')!;
    speed.value = String([...speed.options].findIndex((o) => o.textContent === '4x'));
    speed.dispatchEvent(new Event('change'));
    run(250);
    expect(clock()).toBe('00:02 / 00:05');
    run(500);
    expect(chat().at(-1)).toBe('mira: hello');
    expect(sounds).toContain('chat');

    run(5000);
    expect(clock()).toBe('00:05 / 00:05');
    expect(root.textContent).toContain('Play');
  });

  it('seeking rebuilds the chat log up to the new position', () => {
    viewer.seek(300);
    expect(chat().at(-1)).toBe('mira: hello');
    viewer.seek(1);
    expect(chat()).toEqual(['mira has joined', 'dktest: before kickoff']);
    viewer.seek(0);
    expect(chat()).toEqual([]);
    expect(root.querySelector('.dk-replay-idle')!.hasAttribute('hidden')).toBe(false);
  });

  it('lists the players with their recorded ping and the recorder\'s handicap', () => {
    const rows = () => [...root.querySelectorAll('.dk-replay-players li')].map((li) => [li.className, ...[...li.children].map((c) => c.textContent)]);
    viewer.seek(50);
    expect(rows()).toEqual([
      ['red', 'dktest', '0'],
      ['blue', 'mira', '0'],
    ]);
    viewer.seek(102);
    expect(rows()).toEqual([
      ['red', 'dktest', '0', '40'],
      ['blue', 'mira', '0'],
    ]);
    expect(root.querySelector('.dk-replay-handicap')).not.toBeNull();
    viewer.seek(103);
    expect(rows()).toEqual([
      ['red', 'dktest', '32', '40'],
      ['blue', 'mira', '84'],
    ]);
  });

  it('has keyboard shortcuts that stay quiet while a text field has focus', () => {
    const press = (key: string, target: EventTarget = window) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const speed = () => {
      const el = root.querySelector<HTMLSelectElement>('select[aria-label="Speed"]')!;
      return el.options[el.selectedIndex].textContent;
    };
    press(' ');
    expect(root.textContent).toContain('Pause');
    press(' ');
    expect(root.textContent).toContain('Play');

    press('ArrowRight');
    expect(clock()).toBe('00:05 / 00:05');
    press('ArrowRight');
    expect(clock()).toBe('00:05 / 00:05');
    press('ArrowLeft');
    expect(clock()).toBe('00:00 / 00:05');
    viewer.seek(120);
    press('ArrowLeft');
    expect(clock()).toBe('00:00 / 00:05');

    press('ArrowUp');
    expect(speed()).toBe('2x');
    press('+');
    press('+');
    expect(speed()).toBe('4x');
    press('ArrowDown');
    press('-');
    press('-');
    press('-');
    expect(speed()).toBe('0.5x');

    const field = document.createElement('input');
    root.append(field);
    press(' ', field);
    press('ArrowUp', field);
    press('Escape', field);
    expect(root.textContent).toContain('Play');
    expect(speed()).toBe('0.5x');
    expect(onLeave).not.toHaveBeenCalled();

    press('Escape');
    expect(onLeave).toHaveBeenCalledOnce();
    press(' ');
    expect(root.textContent).toContain('Play');
  });

  it('opens at the second it is given and offers no link for a replay from a file', () => {
    const at = new ReplayViewer({ replay: recordedMatch().replay, settings: createSettingsStore(new MemoryStorage()), createRenderer: () => ({ render: () => {}, resize: () => {} }), playSound: () => {}, download, onLeave, startAt: 2 });
    root.append(at.el);
    at.update(0);
    expect(at.el.querySelector('.dk-replay-clock')!.textContent).toBe('00:02 / 00:05');
    expect([...at.el.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Link');
    at.dispose();
  });

  it('saves the part between two times as its own replay, refusing times out of order', () => {
    viewer.seek(60);
    click(root, 'Clip');
    const [from, to] = root.querySelectorAll<HTMLInputElement>('.dk-dialog input');
    expect([from.value, to.value]).toEqual(['00:01', '00:05']);
    to.value = '0:01';
    click(root, 'Save');
    expect(root.querySelector('.dk-error')!.hasAttribute('hidden')).toBe(false);
    expect(download).not.toHaveBeenCalled();
    to.value = '3';
    click(root, 'Save');
    const [name, data] = download.mock.calls[0];
    expect(name).toBe('clip 00.01-00.03.glx');
    const clip = decodeReplay(data);
    expect(clip.frames).toHaveLength(120);
    expect(clip.start.players.map((p) => p.name)).toEqual(['dktest', 'mira']);
    expect(root.querySelector('.dk-dialog')).toBeNull();
  });

  it('locks the camera to a chosen player or the ball and leaves', () => {
    viewer.seek(10);
    expect([...cameraSelect().options].map((o) => o.textContent)).toEqual(['Ball', 'dktest', 'mira']);
    cameraSelect().value = '2';
    cameraSelect().dispatchEvent(new Event('change'));
    viewer.seek(20);
    expect(frames.at(-1)!.localPlayerId).toBe(2);
    click(root, 'Leave');
    expect(onLeave).toHaveBeenCalledOnce();
  });
});

describe('replay links', () => {
  const bytes = encodeReplay(recordedMatch().replay);
  const fetchMock = vi.fn<typeof fetch>();
  let root: HTMLElement;

  const app = () =>
    new App({
      root,
      settings: createSettingsStore(new MemoryStorage()),
      storage: new MemoryStorage(),
      theme: defaultTheme,
      rooms: { list: async () => [], lobby: async () => ({ country: '', notice: '', captchaSiteKey: '' }) },
      join: vi.fn(),
      create: vi.fn(),
      roomLink: () => 'link',
      playSound: () => {},
      setRecording: () => {},
      setHandicap: () => {},
    });

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  });

  afterEach(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    root.remove();
  });

  it('reads the file url and start second from a /replay page link only, and writes such links', () => {
    expect(replayLink({ pathname: '/replay', search: '?url=https%3A%2F%2Ffiles.example%2Fa%20b.glx' })).toEqual({ url: 'https://files.example/a b.glx', at: 0 });
    expect(replayLink({ pathname: '/replay', search: '?url=https://files.example/a.glx&t=90' })).toEqual({ url: 'https://files.example/a.glx', at: 90 });
    expect(replayLink({ pathname: '/replay', search: '?url=https://files.example/a.glx&t=soon' })?.at).toBe(0);
    expect(replayLink({ pathname: '/replay', search: '' })).toBeUndefined();
    expect(replayLink({ pathname: '/play', search: '?url=https://files.example/a.glx' })).toBeUndefined();
    const link = replayPageLink('https://golix.example', 'https://files.example/a b.glx', 61.7);
    expect(replayLink(new URL(link))).toEqual({ url: 'https://files.example/a b.glx', at: 61 });
    expect([parseClock('1:05'), parseClock('42'), parseClock(' 0:30.5 '), parseClock('1:'), parseClock('x')]).toEqual([65, 42, 30.5, null, null]);
  });

  it('fetches https files and turns every failure into the load error', async () => {
    expect(new Uint8Array(await fetchReplay('https://files.example/a.glx'))).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledWith('https://files.example/a.glx');
    for (const link of ['http://files.example/a.glx', 'file:///a.glx', 'not a url']) {
      await expect(fetchReplay(link)).rejects.toThrow(new ReplayError("Couldn't load the file."));
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(fetchReplay('https://files.example/a.glx')).rejects.toThrow("Couldn't load the file.");
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchReplay('https://files.example/a.glx')).rejects.toThrow("Couldn't load the file.");
  });

  it('opens the viewer straight from the link and asks for the nickname on leaving', async () => {
    app().start(undefined, { url: 'https://files.example/a.glx', at: 0 });
    await vi.waitFor(() => expect(root.querySelector('.dk-replay-view')).not.toBeNull());
    click(root, 'Link');
    expect(root.querySelector<HTMLInputElement>('.dk-dialog input')!.value).toBe(replayPageLink(location.origin, 'https://files.example/a.glx', 0));
    click(root, 'Close');
    expect(root.querySelector('.dk-nickname')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root.querySelector('.dk-nickname')).not.toBeNull();
  });

  it('shows the replay error texts for a file that fails to load or decode', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"name": "stadium"}'));
    for (const link of ['http://files.example/a.glx', 'https://files.example/stadium.hbs']) {
      root.replaceChildren();
      app().start(undefined, { url: link, at: 0 });
      const dialog = await vi.waitFor(() => {
        const el = root.querySelector('.dk-dialog');
        if (el === null) throw new Error('no dialog yet');
        return el;
      });
      expect(dialog.textContent).toContain('Replay error');
      expect(dialog.textContent).toContain("Couldn't load the file.");
      click(dialog, 'Ok');
      expect(root.querySelector('.dk-nickname')).not.toBeNull();
    }
  });
});
