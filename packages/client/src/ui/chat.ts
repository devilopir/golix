import type { RoomEvent, TickOutcome } from '@golix/shared';
import type { SoundName } from '../audio/recipes.ts';
import { css } from '../render/color.ts';
import type { RoomSession } from '../session.ts';
import type { SettingsStore } from '../settings/settings.ts';
import { h } from './dom.ts';
import { completeMention, mentionCandidates, mentionFragment, mentionName, mentions, type MentionPlayer } from './mentions.ts';
import { teamName } from '../render/hud.ts';
import { describeEvent } from './notices.ts';

export const CHAT_MAX_LENGTH = 140;
const STICK_TO_BOTTOM_PX = 24;
const MIN_HEIGHT_PX = 40;
const MAX_HEIGHT_VIEWPORT = 0.35;

export interface ChatDeps {
  session: RoomSession;
  settings: SettingsStore;
  command(line: string, reply: (text: string) => void): void;
  playSound(name: SoundName): void;
}

export class ChatPanel {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly log: HTMLElement;
  /** True while the reader is at the newest line; the log keeps following it through new lines and resizes. */
  private stick = true;
  private readonly followResize: ResizeObserver;
  private readonly suggestions: HTMLElement;
  private readonly names = new Map<number, string>();
  private typing = false;
  private candidates: MentionPlayer[] = [];
  private selected = 0;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly deps: ChatDeps) {
    for (const p of deps.session.getRoom().players) this.names.set(p.id, p.name);
    this.log = h('div', { className: 'dk-chat-log', onscroll: () => (this.stick = this.atBottom()) });
    this.followResize = new ResizeObserver(() => this.stick && this.scrollToEnd());
    this.followResize.observe(this.log);
    this.suggestions = h('ul', { className: 'dk-chat-suggestions', hidden: true });
    this.input = h('input', {
      className: 'dk-chat-input',
      type: 'text',
      maxLength: CHAT_MAX_LENGTH,
      placeholder: 'Enter or Tab to chat',
      onkeydown: this.onKeyDown,
      oninput: this.onInput,
      onfocus: () => this.setFocused(true),
      onblur: () => this.setFocused(false),
    });
    const resize = h('div', { className: 'dk-chat-resize', onpointerdown: this.startResize });
    this.el = h('section', { className: 'dk-chat' }, resize, this.log, this.suggestions, this.input);
    this.unsubscribe = [
      deps.session.onEvent(this.onEvent),
      deps.session.onTick(this.onOutcomes),
      deps.settings.subscribe(() => this.applySettings()),
    ];
    this.applySettings();
  }

  dispose(): void {
    this.followResize.disconnect();
    for (const off of this.unsubscribe) off();
  }

  notice(text: string, className = 'notice'): HTMLElement {
    return this.append(text, className);
  }

  focus(): void {
    this.input.focus();
  }

  toggleVisible(): void {
    this.el.classList.toggle('hidden');
  }

  private nameOf = (id: number): string => this.names.get(id) ?? `#${id}`;

  private get selfName(): string {
    return this.nameOf(this.deps.session.playerId);
  }

  private atBottom(): boolean {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < STICK_TO_BOTTOM_PX;
  }

  private scrollToEnd(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }

  private append(text: string, className: string): HTMLElement {
    const line = h('p', { className: `dk-chat-line ${className}`, textContent: text });
    this.log.append(line);
    if (this.stick) this.scrollToEnd();
    return line;
  }

  private readonly onEvent = (ev: RoomEvent): void => {
    if (ev.type === 'playerJoin') this.names.set(ev.player.id, ev.player.name);
    if (ev.type === 'chat') {
      const highlight = mentions(ev.text, this.selfName);
      this.append(`${this.nameOf(ev.playerId)}: ${ev.text}`, highlight ? 'highlight' : 'message');
      this.deps.playSound(highlight ? 'mention' : 'chat');
      return;
    }
    if (ev.type === 'announcement') {
      if (ev.targetId !== null && ev.targetId !== this.deps.session.playerId) return;
      const line = this.append(ev.text, `announcement ${ev.style}`);
      if (ev.color !== -1) line.style.color = css(ev.color);
      if (ev.sound !== 0) this.deps.playSound(ev.sound === 2 ? 'mention' : 'chat');
      return;
    }
    const comings = ev.type === 'playerJoin' || (ev.type === 'playerLeave' && !ev.kicked);
    if (comings && !this.deps.settings.get('joinLeaveNotices')) return;
    const text = describeEvent(ev, this.nameOf, this.deps.session.getRoom());
    if (text !== null) this.notice(text);
    if (ev.type === 'playerJoin') this.deps.playSound('join');
    if (ev.type === 'playerLeave') this.deps.playSound('leave');
  };

  /** Follows the pointer once per frame and saves the height when the drag ends. */
  private readonly startResize = (down: PointerEvent): void => {
    down.preventDefault();
    const { settings } = this.deps;
    const startHeight = settings.get('chatHeight');
    let height = startHeight;
    let frame = 0;
    this.el.classList.add('resizing');
    const move = (e: PointerEvent) => {
      const max = Math.max(MIN_HEIGHT_PX, window.innerHeight * MAX_HEIGHT_VIEWPORT);
      height = Math.round(Math.min(Math.max(startHeight + down.clientY - e.clientY, MIN_HEIGHT_PX), max));
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          this.el.style.setProperty('--dk-chat-height', `${height}px`);
        });
      }
    };
    const up = () => {
      cancelAnimationFrame(frame);
      this.el.classList.remove('resizing');
      settings.set('chatHeight', height);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  private readonly onOutcomes = (_tick: number, outcomes: readonly TickOutcome[]): void => {
    for (const o of outcomes) if (o.type === 'victory') this.notice(`${teamName(this.deps.session.getRoom(), o.team)} team won the match`);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.submit();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const completed = completeMention(this.input.value, this.deps.session.getRoom().players, this.selected);
      if (completed === null) {
        this.input.blur();
      } else {
        this.input.value = completed.slice(0, CHAT_MAX_LENGTH);
        this.onInput();
      }
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && this.candidates.length > 0) {
      event.preventDefault();
      const n = this.candidates.length;
      this.selected = (this.selected + (event.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.renderSuggestions();
    } else if (event.key === 'Escape') {
      this.input.blur();
    }
  };

  private readonly onInput = (): void => {
    const fragment = mentionFragment(this.input.value);
    this.candidates = fragment === null ? [] : mentionCandidates(fragment.text, this.deps.session.getRoom().players);
    this.selected = 0;
    this.renderSuggestions();
    this.updateTyping();
  };

  private renderSuggestions(): void {
    this.suggestions.replaceChildren(...this.candidates.map((p, i) => h('li', { textContent: mentionName(p.name), className: i === this.selected ? 'selected' : '' })));
    this.suggestions.hidden = this.candidates.length === 0;
  }

  private submit(): void {
    const text = this.input.value;
    this.input.value = '';
    this.onInput();
    this.input.blur();
    if (text.trim() === '') return;
    if (text.startsWith('/')) this.deps.command(text, (reply) => this.notice(reply));
    else this.deps.session.send({ type: 'chat', text });
  }

  private setFocused(focused: boolean): void {
    this.el.classList.toggle('focused', focused);
    if (!focused) this.suggestions.hidden = true;
    this.updateTyping();
  }

  private updateTyping(): void {
    const typing = document.activeElement === this.input && this.input.value !== '';
    if (typing === this.typing) return;
    this.typing = typing;
    this.deps.session.send({ type: 'request', event: { type: 'setTyping', playerId: this.deps.session.playerId, typing } });
  }

  private applySettings(): void {
    const { settings } = this.deps;
    this.el.style.setProperty('--dk-chat-opacity', String(settings.get('chatOpacity')));
    const maxHeight = Math.max(MIN_HEIGHT_PX, window.innerHeight * MAX_HEIGHT_VIEWPORT);
    this.el.style.setProperty('--dk-chat-height', `${Math.min(settings.get('chatHeight'), maxHeight)}px`);
    this.el.style.setProperty('--dk-chat-focus-height', `${settings.get('chatFocusHeight')}px`);
    this.el.classList.toggle('full', settings.get('chatBackgroundWidth') === 'full');
  }
}
