import { REPLAY_EXTENSION, REPLAY_LOAD_ERROR, ReplayError, ReplayPlayer, encodeReplay, trimReplay, type FrameResult, type Replay } from '@golix/replay';
import { TICKS_PER_SECOND, Team, type PlayingTeam, type RoomEvent, type RoomState, type TickOutcome } from '@golix/shared';
import type { SoundName } from '../audio/recipes.ts';
import { isTextField } from '../input/keyboard.ts';
import { css } from '../render/color.ts';
import { formatClock } from '../render/hud.ts';
import type { Renderer } from '../render/index.ts';
import type { SettingsStore } from '../settings/settings.ts';
import { button, cancelButton, h, labeled, openDialog, select } from './dom.ts';
import { teamName } from '../render/hud.ts';
import { describeEvent } from './notices.ts';

export interface ReplayViewerDeps {
  replay: Replay;
  settings: SettingsStore;
  createRenderer(canvas: HTMLCanvasElement): Renderer;
  playSound(name: SoundName): void;
  download(filename: string, data: Uint8Array<ArrayBuffer>): void;
  onLeave(): void;
  /** The https address the replay was opened from; lets the viewer share a link to the current moment. */
  url?: string;
  /** Seconds into the replay to open at. */
  startAt?: number;
}

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;
/** Camera choice that follows the ball instead of a player. */
const FOLLOW_BALL = -1;
const MAX_STEP_MS = 250;
const SEEK_STEP = 5 * TICKS_PER_SECOND;
const TEAM_CLASSES = { [Team.spectators]: 'spectators', [Team.red]: 'red', [Team.blue]: 'blue' } as const;
const CHAT_LINES = 100;
const OUTCOME_SOUNDS: Partial<Record<TickOutcome['type'], SoundName>> = { kick: 'kick', goal: 'goal' };
const NO_TYPING: ReadonlySet<number> = new Set();

/** The replay file a `/replay?url=<file url>` page link points to. */
/** The file url of a /replay page link, and `t`, the second to open at (0 when missing or not a number). */
export function replayLink(location: { pathname: string; search: string }): { url: string; at: number } | undefined {
  if (location.pathname !== '/replay') return undefined;
  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  const at = Number(params.get('t') ?? 0);
  return url === null ? undefined : { url, at: Number.isFinite(at) && at > 0 ? at : 0 };
}

/** A link to the replay page that opens the file at `seconds`. */
export function replayPageLink(origin: string, url: string, seconds: number): string {
  return `${origin}/replay?${new URLSearchParams({ url, t: String(Math.floor(seconds)) })}`;
}

/** Reads "m:ss" or plain seconds; null when it is neither. */
export function parseClock(text: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
  return m === null ? null : Number(m[1] ?? 0) * 60 + Number(m[2]);
}

/** Only https files load; the file's server must allow this site through CORS. */
export async function fetchReplay(link: string): Promise<ArrayBuffer> {
  const res = URL.canParse(link) && new URL(link).protocol === 'https:' ? await fetch(link).catch(() => null) : null;
  if (!res?.ok) throw new ReplayError(REPLAY_LOAD_ERROR);
  return res.arrayBuffer().catch(() => {
    throw new ReplayError(REPLAY_LOAD_ERROR);
  });
}

interface ChatLine {
  text: string;
  className: string;
  color: number;
}

export class ReplayViewer {
  readonly el: HTMLElement;
  private readonly player: ReplayPlayer;
  private readonly canvas = h('canvas', { className: 'dk-game-canvas' });
  private readonly renderer: Renderer;
  private readonly idle = h('p', { className: 'dk-replay-idle', textContent: 'No game in progress' });
  private readonly log = h('div', { className: 'dk-chat-log' });
  private readonly playButton: HTMLButtonElement;
  private readonly clock = h('span', { className: 'dk-replay-clock' });
  private readonly progress = h('div', { className: 'dk-replay-progress' });
  private readonly tooltip = h('span', { className: 'dk-replay-tooltip', hidden: true });
  private readonly timeline: HTMLElement;
  private readonly speedSelect: HTMLSelectElement;
  private readonly players = h('ul', { className: 'dk-replay-players' });
  private playersKey = '';
  private cameraSelect: HTMLSelectElement;
  private cameraKey = '';
  private camera = FOLLOW_BALL;
  private readonly names = new Map<number, string>();
  private scrubbing = false;
  private last: number | null = null;
  private frameHandle: number;

  constructor(private readonly deps: ReplayViewerDeps) {
    this.player = new ReplayPlayer(deps.replay);
    this.renderer = deps.createRenderer(this.canvas);
    this.playButton = button('Play', () => this.togglePlay());
    const speed = select(REPLAY_SPEEDS.map((value) => ({ value, label: `${value}x` })), this.player.speed, (value) => (this.player.speed = value));
    speed.setAttribute('aria-label', 'Speed');
    this.speedSelect = speed;
    this.cameraSelect = this.cameraOptions();
    const marks = this.player.marks
      .filter((m) => m.outcome.type === 'goal')
      .map((m) => {
        const el = h('span', { className: `dk-replay-mark ${m.outcome.team === Team.red ? 'red' : 'blue'}` });
        el.style.left = `${this.percent(m.frame)}%`;
        return el;
      });
    this.timeline = h('div', { className: 'dk-replay-timeline', onpointerdown: this.onPointerDown, onpointermove: this.onPointerMove, onpointerup: this.onPointerUp, onpointerleave: () => (this.tooltip.hidden = true) }, this.progress, ...marks, this.tooltip);
    this.el = h(
      'div',
      { className: 'dk-replay-view' },
      h('div', { className: 'dk-game-layer' }, this.canvas, this.idle),
      this.players,
      h('section', { className: 'dk-chat dk-replay-chat' }, this.log),
      h(
        'div',
        { className: 'dk-replay-controls' },
        this.playButton,
        this.timeline,
        this.clock,
        speed,
        h('label', { className: 'dk-replay-camera' }, h('span', { textContent: 'Camera' }), this.cameraSelect),
        button('Clip', () => this.openClip()),
        ...(deps.url === undefined ? [] : [button('Link', () => this.openLink(deps.url!))]),
        button('Leave', () => this.leave()),
      ),
    );
    if (deps.startAt !== undefined) this.player.seek(deps.startAt * TICKS_PER_SECOND);
    this.rebuildChat();
    addEventListener('keydown', this.onKeyDown);
    this.frameHandle = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    removeEventListener('keydown', this.onKeyDown);
  }

  /** Saves the part between two moments as its own replay file. */
  private openClip(): void {
    this.player.pause();
    const total = this.player.totalFrames / TICKS_PER_SECOND;
    const now = this.player.frame / TICKS_PER_SECOND;
    const from = h('input', { type: 'text', value: formatClock(now) });
    const to = h('input', { type: 'text', value: formatClock(Math.min(now + 30, total)) });
    const error = h('p', { className: 'dk-error', hidden: true, textContent: 'Enter two times like 1:05, the first before the second.' });
    const dialog = openDialog(this.el, 'Save clip', [labeled('From', from), labeled('To', to), error], [
      cancelButton('Cancel', () => dialog.close()),
      button('Save', () => {
        const start = parseClock(from.value);
        const end = parseClock(to.value);
        if (start === null || end === null || start >= Math.min(end, total)) {
          error.hidden = false;
          return;
        }
        const frames = (s: number) => Math.min(Math.round(s * TICKS_PER_SECOND), this.player.totalFrames);
        const clip = trimReplay(this.deps.replay, frames(start), frames(end));
        this.deps.download(`clip ${formatClock(start).replace(':', '.')}-${formatClock(end).replace(':', '.')}${REPLAY_EXTENSION}`, encodeReplay(clip));
        dialog.close();
      }),
    ]);
  }

  private openLink(url: string): void {
    const link = h('input', { type: 'text', readOnly: true, value: replayPageLink(location.origin, url, this.player.frame / TICKS_PER_SECOND) });
    const dialog = openDialog(this.el, 'Replay link', [h('p', { textContent: 'This link opens the replay at the current moment.' }), link], [
      cancelButton('Close', () => dialog.close()),
      button('Copy to clipboard', () => {
        link.select();
        void navigator.clipboard?.writeText(link.value);
      }),
    ]);
  }

  private leave(): void {
    this.dispose();
    this.deps.onLeave();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTextField(e.target) || this.el.querySelector('.dk-overlay') !== null) return;
    if (e.key === ' ') {
      if (!e.repeat) this.togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.seek(this.player.frame + (e.key === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP));
    } else if (e.key === 'ArrowUp' || e.key === '+' || e.key === 'ArrowDown' || e.key === '-') {
      this.stepSpeed(e.key === 'ArrowUp' || e.key === '+' ? 1 : -1);
    } else if (e.key === 'Escape') {
      this.leave();
    } else {
      return;
    }
    e.preventDefault();
  };

  private stepSpeed(by: 1 | -1): void {
    const i = Math.min(Math.max(REPLAY_SPEEDS.findIndex((v) => v === this.player.speed) + by, 0), REPLAY_SPEEDS.length - 1);
    this.player.speed = REPLAY_SPEEDS[i];
    this.speedSelect.value = String(i);
  }

  /** Plays the time since the previous update and redraws. */
  update(now: number): void {
    const dt = this.last === null ? 0 : Math.min(now - this.last, MAX_STEP_MS);
    this.last = now;
    for (const result of this.player.advance(dt)) this.onFrame(result);
    this.draw();
  }

  seek(frame: number): void {
    this.player.seek(frame);
    this.rebuildChat();
    this.draw();
  }

  togglePlay(): void {
    if (this.player.playing) {
      this.player.pause();
    } else {
      const restart = this.player.frame === this.player.totalFrames;
      this.player.play();
      if (restart) this.rebuildChat();
    }
    this.draw();
  }

  private readonly loop = (now: number): void => {
    this.frameHandle = requestAnimationFrame(this.loop);
    this.update(now);
  };

  private draw(): void {
    const { player, deps } = this;
    const room = player.room;
    const game = room.game;
    this.playButton.textContent = player.playing ? 'Pause' : 'Play';
    this.clock.textContent = `${formatClock(player.frame / TICKS_PER_SECOND)} / ${formatClock(player.totalFrames / TICKS_PER_SECOND)}`;
    this.progress.style.width = `${this.percent(player.frame)}%`;
    this.refreshCamera(room);
    this.refreshPlayers(room);
    this.canvas.hidden = game === null;
    this.idle.hidden = game !== null;
    if (game === null) return;
    this.renderer.render({
      prev: player.previous.game ?? game,
      curr: game,
      alpha: player.alpha,
      room,
      localPlayerId: this.camera === FOLLOW_BALL ? null : this.camera,
      typingPlayerIds: NO_TYPING,
      menuOpen: false,
      view: {
        viewMode: deps.settings.get('viewMode'),
        resolutionScale: deps.settings.get('resolutionScale'),
        showNames: true,
        showAvatars: deps.settings.get('avatarsEnabled'),
        customTeamColors: deps.settings.get('teamColorsEnabled'),
        showTypingIndicators: false,
        clampCamera: true,
        bottomInset: 0,
      },
    });
  }

  private percent(frame: number): number {
    return this.player.totalFrames === 0 ? 0 : (100 * frame) / this.player.totalFrames;
  }

  private frameAt(clientX: number): number {
    const rect = this.timeline.getBoundingClientRect();
    const x = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width;
    return Math.round(Math.min(Math.max(x, 0), 1) * this.player.totalFrames);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.scrubbing = true;
    this.timeline.setPointerCapture(e.pointerId);
    this.seek(this.frameAt(e.clientX));
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const frame = this.frameAt(e.clientX);
    const time = this.player.timeAt(frame);
    this.tooltip.hidden = false;
    this.tooltip.textContent = Number.isNaN(time) ? '-' : formatClock(time);
    this.tooltip.style.left = `${this.percent(frame)}%`;
    if (this.scrubbing) this.seek(frame);
  };

  private readonly onPointerUp = (): void => {
    this.scrubbing = false;
  };

  private cameraOptions(): HTMLSelectElement {
    const players = this.player.room.players.filter((p) => p.team !== Team.spectators);
    if (!players.some((p) => p.id === this.camera)) this.camera = FOLLOW_BALL;
    const el = select([{ value: FOLLOW_BALL, label: 'Ball' }, ...players.map((p) => ({ value: p.id, label: p.name }))], this.camera, (value) => (this.camera = value));
    el.setAttribute('aria-label', 'Camera');
    return el;
  }

  private refreshCamera(room: RoomState): void {
    const key = room.players.map((p) => `${p.id}:${p.team}:${p.name}`).join(',');
    if (key === this.cameraKey) return;
    this.cameraKey = key;
    const next = this.cameraOptions();
    this.cameraSelect.replaceWith(next);
    this.cameraSelect = next;
  }

  /** Pings come from the recorded ping events; only the recorder's own handicap is known. */
  private refreshPlayers(room: RoomState): void {
    const rows = room.players.map((p) => ({ player: p, handicap: this.player.handicap(p.id) }));
    const key = rows.map(({ player: p, handicap }) => `${p.id}:${p.team}:${p.name}:${p.ping}:${handicap}`).join(',');
    if (key === this.playersKey) return;
    this.playersKey = key;
    this.players.replaceChildren(
      ...rows.map(({ player, handicap }) =>
        h(
          'li',
          { className: TEAM_CLASSES[player.team] },
          h('span', { className: 'dk-player-name', textContent: player.name }),
          h('span', { className: 'dk-ping', textContent: String(player.ping) }),
          ...(handicap > 0 ? [h('span', { className: 'dk-replay-handicap', textContent: String(handicap) })] : []),
        ),
      ),
    );
  }

  private onFrame(result: FrameResult): void {
    for (const ev of result.events) {
      const line = this.lineFor(ev);
      if (line !== null) this.append(line);
      if (ev.type === 'chat') this.deps.playSound('chat');
    }
    for (const o of result.outcomes) {
      const sound = OUTCOME_SOUNDS[o.type];
      if (sound !== undefined) this.deps.playSound(sound);
      if (o.type === 'victory') this.append(victoryLine(this.player.room, o.team));
    }
  }

  private lineFor(ev: RoomEvent): ChatLine | null {
    if (ev.type === 'playerJoin') this.names.set(ev.player.id, ev.player.name);
    if (ev.type === 'chat') return { text: `${this.nameOf(ev.playerId)}: ${ev.text}`, className: 'message', color: -1 };
    if (ev.type === 'announcement') return ev.targetId === null ? { text: ev.text, className: `announcement ${ev.style}`, color: ev.color } : null;
    const text = describeEvent(ev, this.nameOf, this.player.room);
    return text === null ? null : { text, className: 'notice', color: -1 };
  }

  private readonly nameOf = (id: number): string => this.names.get(id) ?? `#${id}`;

  private append(line: ChatLine): void {
    this.log.append(chatLine(line));
    while (this.log.childElementCount > CHAT_LINES) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Lists the chat and notices of every frame up to the current one, as playback would have. */
  private rebuildChat(): void {
    const { replay } = this.deps;
    const lines: ChatLine[] = [];
    this.names.clear();
    const learn = (room: RoomState) => room.players.forEach((p) => this.names.set(p.id, p.name));
    learn(replay.start);
    let mark = 0;
    const { marks } = this.player;
    for (let i = 0; i < this.player.frame; i++) {
      const frame = replay.frames[i];
      if (frame.kind === 'snapshot') learn(frame.room);
      else for (const ev of frame.events) {
        const line = this.lineFor(ev);
        if (line !== null) lines.push(line);
      }
      for (; mark < marks.length && marks[mark].frame === i + 1; mark++) {
        const { outcome } = marks[mark];
        if (outcome.type === 'victory') lines.push(victoryLine(this.player.room, outcome.team));
      }
    }
    this.log.replaceChildren(...lines.slice(-CHAT_LINES).map(chatLine));
    this.log.scrollTop = this.log.scrollHeight;
  }
}

function victoryLine(room: RoomState, team: PlayingTeam): ChatLine {
  return { text: `${teamName(room, team)} team won the match`, className: 'notice', color: -1 };
}

function chatLine({ text, className, color }: ChatLine): HTMLElement {
  const el = h('p', { className: `dk-chat-line ${className}`, textContent: text });
  if (color !== -1) el.style.color = css(color);
  return el;
}
