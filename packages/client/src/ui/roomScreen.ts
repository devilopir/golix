import { flagEmoji } from './countries.ts';
import { Team, type RoomEvent, type RoomPlayer, type RoomState } from '@golix/shared';
import type { RoomSession } from '../session.ts';
import { button, cancelButton, h, openDialog, select } from './dom.ts';
import { anyTeamName, TEAM_NAMES } from './notices.ts';
import { openPlayerMenu } from './playerMenu.ts';
import type { RoomMods } from './modPanel.ts';
import { openStadiumPicker } from './stadiumPicker.ts';
import { isDefaultStadium, stadiumName, type StadiumStore } from './stadiums.ts';
import { autoAssign, canSelfMove, isAdmin, moveAllToSpectators, randomizeTeams, type TeamMove } from './teams.ts';

/** GameState.pauseCounter holds this value for as long as the game is paused. */
const PAUSED_COUNTER = 120;
const LIMIT_OPTIONS = Array.from({ length: 15 }, (_, value) => ({ value, label: String(value) }));
const TEAM_ORDER = [Team.red, Team.spectators, Team.blue] as const;
/** How far a finger moves on a player row before it counts as a drag rather than a tap or long press. */
const TOUCH_DRAG_PX = 8;

export interface RoomScreenDeps {
  session: RoomSession;
  stadiums: StadiumStore;
  host: HTMLElement;
  roomLink: string;
  random: () => number;
  download(filename: string, text: string): void;
  onLeave(): void;
  onRecord(recording: boolean): void;
  /** The host's tools; null in rooms this browser does not host. */
  mods: RoomMods | null;
}

export function isPaused(room: RoomState): boolean {
  return room.game !== null && room.game.pauseCounter === PAUSED_COUNTER;
}

export class RoomScreen {
  readonly el: HTMLElement;
  private readonly title = h('h1');
  private readonly columns = new Map<Team, HTMLElement>();
  private readonly columnTeams = new Map<HTMLElement, Team>();
  private readonly headers = new Map<Team, HTMLButtonElement>();
  private readonly adminOnly: HTMLButtonElement[] = [];
  private readonly clearButtons: HTMLButtonElement[] = [];
  private readonly lockButton: HTMLButtonElement;
  private readonly startButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly pickButton: HTMLButtonElement;
  private readonly recButton: HTMLButtonElement;
  private readonly timeLimit: HTMLSelectElement;
  private readonly scoreLimit: HTMLSelectElement;
  private readonly timeLimitText = h('span');
  private readonly scoreLimitText = h('span');
  private readonly stadiumLabel = h('span', { className: 'dk-stadium-name' });
  private readonly unsubscribe: (() => void)[];
  private dragged: number | null = null;
  private recording = false;

  constructor(private readonly deps: RoomScreenDeps) {
    const room = deps.session.getRoom();
    const adminButton = (label: string, run: () => void) => {
      const el = button(label, run);
      this.adminOnly.push(el);
      return el;
    };

    this.recButton = button('Rec', () => {
      this.recording = !this.recording;
      this.recButton.classList.toggle('on', this.recording);
      deps.onRecord(this.recording);
    });
    this.lockButton = adminButton('Lock', () => this.request({ type: 'setTeamsLock', locked: !this.room.teamsLock, byPlayer: this.self }));
    this.startButton = adminButton('Start game', () => this.request({ type: 'startGame', byPlayer: this.self }));
    this.stopButton = adminButton('Stop game', () => this.request({ type: 'stopGame', byPlayer: this.self }));
    this.pauseButton = adminButton('Pause (P)', () => this.togglePause());
    this.pickButton = adminButton('Pick', () =>
      openStadiumPicker({
        host: deps.host,
        store: deps.stadiums,
        download: deps.download,
        onPick: (source) => this.request({ type: 'setStadium', source, byPlayer: this.self }),
      }),
    );
    this.timeLimit = select(LIMIT_OPTIONS, room.timeLimit, (value) => this.request({ type: 'setTimeLimit', value, byPlayer: this.self }));
    this.scoreLimit = select(LIMIT_OPTIONS, room.scoreLimit, (value) => this.request({ type: 'setScoreLimit', value, byPlayer: this.self }));

    const teamColumns = TEAM_ORDER.map((team) => this.teamColumn(team));

    this.el = h(
      'div',
      { className: 'dk-room-screen' },
      h(
        'header',
        { className: 'dk-room-header' },
        this.title,
        h(
          'div',
          { className: 'dk-row' },
          ...(deps.mods === null ? [] : [button('Mods', () => deps.mods!.open(deps.host))]),
          this.recButton,
          button('Link', () => this.openLink()),
          button('Leave', () => this.openLeave()),
        ),
      ),
      h(
        'div',
        { className: 'dk-room-body' },
        h(
          'div',
          { className: 'dk-room-tools' },
          adminButton('Auto', () => this.applyMoves(autoAssign(this.room))),
          adminButton('Rand', () => this.applyMoves(randomizeTeams(this.room, deps.random))),
          this.lockButton,
          adminButton('Reset', () => this.applyMoves(moveAllToSpectators(this.room))),
        ),
        h('div', { className: 'dk-teams' }, ...teamColumns),
      ),
      h(
        'footer',
        { className: 'dk-room-footer' },
        h('label', { className: 'dk-field' }, h('span', { textContent: 'Time limit' }), this.timeLimit, this.timeLimitText),
        h('label', { className: 'dk-field' }, h('span', { textContent: 'Score limit' }), this.scoreLimit, this.scoreLimitText),
        h('div', { className: 'dk-field' }, h('span', { textContent: 'Stadium' }), this.stadiumLabel, this.pickButton),
        h('div', { className: 'dk-row dk-game-buttons' }, this.startButton, this.stopButton, this.pauseButton),
      ),
    );
    // Scripts can send hundreds of events a tick, so the screen redraws at most once per tick.
    let changed = false;
    this.unsubscribe = [
      deps.session.onEvent(() => (changed = true)),
      deps.session.onResync(() => this.update()),
      deps.session.onTick((_, outcomes) => {
        if (!changed && !outcomes.some((o) => o.type === 'gameStop')) return;
        changed = false;
        this.update();
      }),
    ];
    this.update();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
  }

  togglePause(): void {
    if (this.room.game === null || !isAdmin(this.room, this.self)) return;
    this.request({ type: 'setPaused', paused: !isPaused(this.room), byPlayer: this.self });
  }

  update(): void {
    const room = this.room;
    const admin = isAdmin(room, this.self);
    const inGame = room.game !== null;
    const selfMove = canSelfMove(room, this.self);

    this.title.textContent = room.name;
    for (const el of [...this.adminOnly, ...this.clearButtons, this.timeLimit, this.scoreLimit]) el.hidden = !admin;
    for (const el of [...this.clearButtons, this.pickButton, this.timeLimit, this.scoreLimit]) el.disabled = inGame;
    this.timeLimitText.hidden = admin;
    this.scoreLimitText.hidden = admin;
    this.lockButton.textContent = room.teamsLock ? 'Unlock' : 'Lock';
    this.lockButton.classList.toggle('on', room.teamsLock);
    this.startButton.hidden = !admin || inGame;
    this.stopButton.hidden = !admin || !inGame;
    this.pauseButton.hidden = !admin || !inGame;
    this.pauseButton.textContent = isPaused(room) ? 'Resume (P)' : 'Pause (P)';
    this.timeLimit.value = String(room.timeLimit);
    this.timeLimitText.textContent = String(room.timeLimit);
    this.scoreLimit.value = String(room.scoreLimit);
    this.scoreLimitText.textContent = String(room.scoreLimit);
    this.stadiumLabel.textContent = stadiumName(room.stadiumSource);
    this.stadiumLabel.classList.toggle('custom', !isDefaultStadium(room.stadiumSource));

    for (const team of TEAM_ORDER) {
      const header = this.headers.get(team)!;
      header.disabled = !selfMove;
      header.textContent = anyTeamName(room, team);
      this.columns.get(team)!.replaceChildren(...room.players.filter((p) => p.team === team).map((p) => this.playerRow(p, admin)));
    }
  }

  private get room(): RoomState {
    return this.deps.session.getRoom();
  }

  private get self(): number {
    return this.deps.session.playerId;
  }

  private request(event: RoomEvent): void {
    this.deps.session.send({ type: 'request', event });
  }

  private applyMoves(moves: TeamMove[]): void {
    for (const { playerId, team } of moves) this.request({ type: 'setTeam', playerId, team, byPlayer: this.self, announce: false });
  }

  private teamColumn(team: Team): HTMLElement {
    const header = button(TEAM_NAMES[team], () => {
      if (canSelfMove(this.room, this.self)) this.request({ type: 'setTeam', playerId: this.self, team, byPlayer: this.self, announce: false });
    }, 'dk-btn dk-team-header');
    this.headers.set(team, header);
    let clear: HTMLButtonElement | null = null;
    if (team !== Team.spectators) {
      clear = button(team === Team.red ? '▶' : '◀', () => this.applyMoves(moveAllToSpectators(this.room, team)), 'dk-btn dk-clear-team');
      clear.setAttribute('aria-label', `Move ${TEAM_NAMES[team]} to Spectators`);
      this.clearButtons.push(clear);
    }
    const list = h('ul', { className: 'dk-list dk-player-list' });
    this.columns.set(team, list);
    const head = h('div', { className: 'dk-team-head' }, ...(team === Team.blue ? [clear, header] : [header, clear]));

    const column = h('div', { className: `dk-team dk-team-${TEAM_NAMES[team].toLowerCase()}` }, head, list);
    this.columnTeams.set(column, team);
    column.addEventListener('dragover', (e) => {
      if (this.dragged === null) return;
      e.preventDefault();
      column.classList.add('drop-target');
    });
    column.addEventListener('dragleave', () => column.classList.remove('drop-target'));
    column.addEventListener('drop', (e) => {
      e.preventDefault();
      column.classList.remove('drop-target');
      const playerId = this.dragged;
      this.dragged = null;
      if (playerId !== null) this.drop(playerId, team);
    });
    return column;
  }

  private drop(playerId: number, team: Team): void {
    if (!isAdmin(this.room, this.self)) return;
    if (this.room.players.find((p) => p.id === playerId)?.team === team) return;
    this.request({ type: 'setTeam', playerId, team, byPlayer: this.self, announce: true });
  }

  /**
   * Touch browsers start HTML drag and drop on long press, if at all, and long press opens the player menu here,
   * so a finger moving off a row drags it instead. Listens on the window because updates replace the rows.
   */
  private touchDrag(down: PointerEvent, playerId: number): void {
    let over: HTMLElement | null = null;
    let dragging = false;
    const mark = (column: HTMLElement | null) => {
      over?.classList.remove('drop-target');
      over = column;
      over?.classList.add('drop-target');
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      if (!dragging && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < TOUCH_DRAG_PX) return;
      dragging = true;
      const column = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.dk-team') ?? null;
      mark(column !== null && this.columnTeams.has(column) ? column : null);
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', finish);
      removeEventListener('pointercancel', finish);
      const column = over;
      mark(null);
      if (e.type === 'pointerup' && column !== null) this.drop(playerId, this.columnTeams.get(column)!);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', finish);
    addEventListener('pointercancel', finish);
  }

  private playerRow(player: RoomPlayer, admin: boolean): HTMLElement {
    const row = h(
      'li',
      { className: `dk-player${player.admin ? ' admin' : ''}${player.id === this.self ? ' self' : ''}`, draggable: admin },
      h('span', { className: 'dk-flag', textContent: flagEmoji(player.country) }),
      h('span', { className: 'dk-player-name', textContent: player.name }),
      h('span', { className: 'dk-ping', textContent: String(player.ping) }),
    );
    row.dataset.playerId = String(player.id);
    row.addEventListener('dragstart', (e) => {
      if (!admin) return e.preventDefault();
      this.dragged = player.id;
      e.dataTransfer?.setData('text/plain', String(player.id));
    });
    row.addEventListener('dragend', () => {
      this.dragged = null;
    });
    row.addEventListener('pointerdown', (e) => {
      if (admin && e.pointerType === 'touch') this.touchDrag(e, player.id);
    });
    row.addEventListener('contextmenu', (e) => {
      if (!admin || player.id === this.self) return;
      e.preventDefault();
      openPlayerMenu(this.deps.host, this.deps.session, player);
    });
    return row;
  }

  private openLink(): void {
    const link = h('input', { type: 'text', readOnly: true, value: this.deps.roomLink });
    const dialog = openDialog(
      this.deps.host,
      'Room link',
      [h('p', { textContent: 'Use this url to link others directly into this room.' }), link],
      [
        cancelButton('Close', () => dialog.close()),
        button('Copy to clipboard', () => {
          link.select();
          void navigator.clipboard?.writeText(link.value);
        }),
      ],
    );
  }

  private openLeave(): void {
    const dialog = openDialog(
      this.deps.host,
      'Leave room?',
      [h('p', { textContent: 'Are you sure you want to leave the room?' })],
      [
        cancelButton('Cancel', () => dialog.close()),
        button('Leave', () => {
          dialog.close();
          this.deps.onLeave();
        }),
      ],
    );
  }
}
