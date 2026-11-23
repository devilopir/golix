import { decodeReplay } from '@golix/replay';
import { Team, type RoomEvent, type TickOutcome } from '@golix/shared';
import type { SoundName } from '../audio/recipes.ts';
import { KeyboardInput, type UiAction } from '../input/keyboard.ts';
import { mergeInputs, TouchControls } from '../input/touch.ts';
import { createRenderer } from '../render/index.ts';
import type { ReplayStore } from '../net/replayStore.ts';
import type { RoomSession } from '../session.ts';
import type { KeyValueStorage, SettingsStore } from '../settings/settings.ts';
import type { Theme } from '../theme/index.ts';
import { ChatPanel } from './chat.ts';
import { runCommand } from './commands.ts';
import { openCreateRoomDialog, type CreateRoomOptions } from './createRoom.ts';
import { button, h, messageDialog, openDialog } from './dom.ts';
import { openNicknameDialog } from './nickname.ts';
import { RoomListScreen, type RoomListEntry, type RoomListSource } from './roomList.ts';
import { fetchReplay, ReplayViewer } from './replayViewer.ts';
import { RoomMods } from './modPanel.ts';
import { RoomScreen } from './roomScreen.ts';
import { openSettingsDialog } from './settingsDialog.ts';
import { openReplaysDialog } from './replaysDialog.ts';
import { downloadFile, StadiumStore } from './stadiums.ts';
import { applyThemeVariables } from './themeVars.ts';

export interface AppDeps {
  root: HTMLElement;
  settings: SettingsStore;
  storage: KeyValueStorage;
  theme: Theme;
  rooms: RoomListSource;
  /** Rejects with the user-facing reason, e.g. "Wrong password.". */
  join(entry: RoomListEntry, password: string): Promise<RoomSession>;
  create(options: CreateRoomOptions): Promise<RoomSession>;
  roomLink(session: RoomSession): string;
  playSound(name: SoundName): void;
  setRecording(session: RoomSession, recording: boolean): void;
  /** Matches saved in this browser; null where it keeps none. */
  replays?: ReplayStore | null;
  setHandicap(ms: number): void;
  /** Rooms this browser hosts; returns whether joiners now get a captcha, or null for other rooms. */
  setRecaptcha?(session: RoomSession, required: boolean): boolean | null;
  /** Sends host events to the room when this browser hosts it; null for anyone else's room. */
  hostEvents?(session: RoomSession): ((ev: RoomEvent) => void) | null;
  random?: () => number;
}

const CONTROLS_TEXT = ['Controls:', 'Move: WASD or Arrows', 'Kick: X, Space, Ctrl, Shift, Numpad 0', 'View: Numbers 1 to 4'];
const CONNECTION_CLOSED = 'Connection closed';
const DISCONNECT_TEXT: Readonly<Record<string, string>> = {
  timeout: 'Connection timed out',
  flood: 'Disconnected for sending too many messages',
  host: 'Lost the connection to the host',
  lobby: 'Lost the connection to the lobby server',
};

interface InRoom {
  session: RoomSession;
  screen: RoomScreen;
  chat: ChatPanel;
  overlay: HTMLElement;
  touch: TouchControls;
  menuOpen: boolean;
  dispose: () => void;
}

export class App {
  /** Where the game renderer mounts its canvas while in a room. */
  readonly gameLayer = h('div', { className: 'dk-game-layer' });
  private readonly stadiums: StadiumStore;
  private readonly roomList: RoomListScreen;
  private room: InRoom | null = null;
  private connecting = false;
  private touchDevice = matchMedia('(pointer: coarse)').matches;

  constructor(private readonly deps: AppDeps) {
    deps.root.classList.add('dk-app');
    applyThemeVariables(deps.root, deps.theme);
    this.stadiums = new StadiumStore(deps.storage);
    this.roomList = new RoomListScreen(deps.root, deps.rooms, deps.settings, {
      join: (entry, password) => void this.connect(() => deps.join(entry, password)),
      create: () => openCreateRoomDialog(deps.root, deps.settings.get('nickname'), (o) => void this.connect(() => deps.create(o))),
      replays: () => openReplaysDialog(deps.root, { store: deps.replays ?? null, download: downloadFile, open: (load) => void this.openReplay(load, () => this.showRoomList()) }),
      settings: () => openSettingsDialog(deps.root, deps.settings),
      changeNick: () => openNicknameDialog(deps.root, deps.settings, () => {}),
    });
    window.addEventListener('touchstart', () => {
      this.touchDevice = true;
      this.updateTouch();
    }, { once: true, passive: true });
  }

  /** Whether the room menu is open over a running match. */
  get menuOpen(): boolean {
    return this.room?.menuOpen ?? false;
  }

  /** Writes a line to the room's chat; nothing happens outside a room. */
  notice(text: string): void {
    this.room?.chat.notice(text);
  }

  /** `link` is a room reached through a room link, joined once the nickname is set; `replay` opens that file first. */
  start(link?: RoomListEntry, replay?: { url: string; at: number }): void {
    const enter = () =>
      openNicknameDialog(this.deps.root, this.deps.settings, () => {
        this.showRoomList();
        if (link !== undefined) this.roomList.join(link);
      });
    if (replay === undefined) enter();
    else void this.openReplay(() => fetchReplay(replay.url), enter, replay);
  }

  private showRoomList(): void {
    this.deps.root.replaceChildren(this.roomList.el);
    void this.roomList.refresh();
  }

  /** `onLeave` also runs once the error dialog is closed; `link` is where a linked replay came from. */
  private async openReplay(load: () => Promise<ArrayBuffer>, onLeave: () => void, link?: { url: string; at: number }): Promise<void> {
    const { deps } = this;
    let viewer: ReplayViewer;
    try {
      viewer = new ReplayViewer({
        replay: decodeReplay(await load()),
        settings: deps.settings,
        createRenderer: (canvas) => createRenderer(canvas, deps.theme, deps.settings.get('lowLatencyCanvas')),
        playSound: deps.playSound,
        download: downloadFile,
        onLeave,
        url: link?.url,
        startAt: link?.at,
      });
    } catch (e) {
      messageDialog(deps.root, 'Replay error', (e as Error).message, onLeave);
      return;
    }
    deps.root.replaceChildren(viewer.el);
  }

  /** Starts one connection at a time, so a double click or a second Join cannot open a second session. */
  private async connect(start: () => Promise<RoomSession>): Promise<void> {
    if (this.connecting || this.room !== null) return;
    this.connecting = true;
    const progress = openDialog(this.deps.root, 'Connecting', [h('p', { textContent: 'Connecting to the room...' })], [], 'dk-connecting');
    try {
      const session = await start();
      progress.close();
      this.enterRoom(session);
    } catch (e) {
      progress.close();
      messageDialog(this.deps.root, 'Disconnected', (e as Error).message);
    } finally {
      this.connecting = false;
    }
  }

  enterRoom(session: RoomSession): void {
    const { deps } = this;
    const hostEvents = deps.hostEvents?.(session) ?? null;
    const mods = hostEvents === null ? null : new RoomMods(session, hostEvents);
    session.onClose(() => mods?.dispose());
    const screen = new RoomScreen({
      mods,
      session,
      stadiums: this.stadiums,
      host: deps.root,
      roomLink: deps.roomLink(session),
      random: deps.random ?? Math.random,
      download: downloadFile,
      onLeave: () => {
        session.leave();
        this.exitRoom();
        this.showRoomList();
      },
      onRecord: (recording) => deps.setRecording(session, recording),
    });
    const chat = new ChatPanel({
      session,
      settings: deps.settings,
      playSound: deps.playSound,
      command: (line, reply) =>
        runCommand(line, {
          session,
          settings: deps.settings,
          stadiums: this.stadiums,
          defaultColors: deps.theme.teams,
          setHandicap: deps.setHandicap,
          setRecaptcha: (required) => deps.setRecaptcha?.(session, required) ?? null,
          reply,
        }),
    });
    const overlay = h('div', { className: 'dk-room-overlay' }, screen.el);
    let keys = 0;
    let touched = 0;
    let sent = 0;
    const send = () => {
      const input = mergeInputs(keys, touched);
      if (input === sent) return;
      sent = input;
      session.sendInput(input);
    };
    const keyboard = new KeyboardInput(window, {
      bindings: () => deps.settings.get('keyBindings'),
      onInput: (input) => {
        keys = input;
        send();
      },
      onUiAction: (action) => this.onUiAction(action),
    });
    const touch = new TouchControls((input) => {
      touched = input;
      send();
    });
    chat.el.addEventListener('focusin', () => this.updateTouch());
    chat.el.addEventListener('focusout', () => this.updateTouch());
    const offSettings = deps.settings.subscribe(() => this.updateTouch());
    const offEvents = session.onEvent((ev) => this.onEvent(ev));
    const offTicks = session.onTick((_, outcomes) => this.onOutcomes(outcomes));
    const offResync = session.onResync(() => this.updateOverlay());
    const offClose = session.onClose((reason) => reason !== 'left' && this.disconnected(DISCONNECT_TEXT[reason] ?? CONNECTION_CLOSED));
    const view = h('div', { className: 'dk-room-view' }, this.gameLayer, touch.el, overlay, this.topBar(), chat.el);
    // The camera centres on the space above the resting chat, so growing the chat while typing does not move the pitch.
    const chatSpace = new ResizeObserver(() => {
      if (!chat.el.classList.contains('focused')) view.style.setProperty('--dk-chat-space', `${chat.el.offsetHeight}px`);
    });
    chatSpace.observe(chat.el);
    this.room = {
      session,
      screen,
      chat,
      overlay,
      touch,
      menuOpen: false,
      dispose: () => {
        offSettings();
        touch.dispose();
        offEvents();
        offTicks();
        offResync();
        offClose();
        keyboard.dispose();
        screen.dispose();
        chat.dispose();
        chatSpace.disconnect();
      },
    };
    deps.root.replaceChildren(view);
    for (const line of CONTROLS_TEXT) chat.notice(line);
    chat.notice(`Extrapolation set to ${deps.settings.get('extrapolation')} msec`);
    this.updateOverlay();
  }

  private exitRoom(): void {
    this.room?.dispose();
    this.room = null;
  }

  private topBar(): HTMLElement {
    const { settings } = this.deps;
    const volume = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(settings.get('volume')) });
    volume.oninput = () => settings.set('volume', Number(volume.value));
    volume.setAttribute('aria-label', 'Volume');
    const mute = button('Sound', () => {
      settings.set('soundEnabled', !settings.get('soundEnabled'));
      mute.classList.toggle('on', settings.get('soundEnabled'));
    }, 'dk-btn dk-toggle');
    mute.classList.toggle('on', settings.get('soundEnabled'));
    return h(
      'div',
      { className: 'dk-top-bar' },
      h('div', { className: 'dk-volume' }, mute, volume),
      button('Menu', () => this.toggleMenu()),
      button('Settings', () => openSettingsDialog(this.deps.root, settings)),
    );
  }

  private toggleMenu(): void {
    if (this.room === null || this.room.session.getRoom().game === null) return;
    this.room.menuOpen = !this.room.menuOpen;
    this.updateOverlay();
  }

  private updateOverlay(): void {
    if (this.room === null) return;
    const { session, overlay, menuOpen } = this.room;
    overlay.hidden = session.getRoom().game !== null && !menuOpen;
    this.updateTouch();
  }

  /** Touch controls show on touch devices for a player on the pitch, unless chat or the room menu is open. */
  private updateTouch(): void {
    if (this.room === null) return;
    const { session, chat, touch, menuOpen } = this.room;
    const { settings } = this.deps;
    const room = session.getRoom();
    const self = room.players.find((p) => p.id === session.playerId);
    touch.setSize(settings.get('joystickSize'));
    touch.setActive(
      this.touchDevice &&
        settings.get('touchControlsEnabled') &&
        room.game !== null &&
        self !== undefined &&
        self.team !== Team.spectators &&
        !menuOpen &&
        !chat.el.classList.contains('focused'),
      room.actionKeys,
    );
  }

  private onEvent(ev: RoomEvent): void {
    const room = this.room;
    if (room === null) return;
    if (ev.type === 'startGame' || ev.type === 'stopGame') room.menuOpen = false;
    if (ev.type === 'playerLeave' && ev.playerId === room.session.playerId) {
      const kicker = ev.byPlayer === null ? undefined : room.session.getRoom().players.find((p) => p.id === ev.byPlayer);
      const by = kicker === undefined ? '' : ` by ${kicker.name}`;
      const reason = ev.reason === '' ? '' : ` (${ev.reason})`;
      this.disconnected(`You were ${ev.ban ? 'banned' : 'kicked'}${by}${reason}`);
      return;
    }
    this.updateOverlay();
  }

  private disconnected(text: string): void {
    this.exitRoom();
    this.showRoomList();
    messageDialog(this.deps.root, 'Disconnected', text);
  }

  private onOutcomes(outcomes: readonly TickOutcome[]): void {
    if (this.room === null || !outcomes.some((o) => o.type === 'gameStop')) return;
    this.room.menuOpen = false;
    this.updateOverlay();
  }

  private onUiAction(action: UiAction): void {
    const room = this.room;
    if (room === null) return;
    switch (action.type) {
      case 'focusChat':
        return room.chat.focus();
      case 'toggleChat':
        return room.chat.toggleVisible();
      case 'menu':
        return this.toggleMenu();
      case 'pause':
        return room.screen.togglePause();
      case 'viewMode':
        this.deps.settings.set('viewMode', action.mode);
    }
  }
}
