// @vitest-environment happy-dom
import { Team } from '@golix/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoundName } from '../../src/audio/recipes.ts';
import { createSettingsStore, type SettingsStore } from '../../src/settings/settings.ts';
import { ChatPanel } from '../../src/ui/chat.ts';
import { completeMention, mentionCandidates, mentionFragment, mentions } from '../../src/ui/mentions.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { FakeSession, player, room } from './fakes.ts';

describe('mentions', () => {
  const players = [
    { id: 1, name: 'dktest' },
    { id: 7, name: 'Deniz Kaya' },
    { id: 12, name: 'mira' },
  ];

  it('finds the fragment after a trailing @ or #', () => {
    expect(mentionFragment('hi @d')).toEqual({ sigil: '@', text: 'd' });
    expect(mentionFragment('@')).toEqual({ sigil: '@', text: '' });
    expect(mentionFragment('!kick #mi')).toEqual({ sigil: '#', text: 'mi' });
    expect(mentionFragment('mail a@b')).toBeNull();
    expect(mentionFragment('issue a#1')).toBeNull();
    expect(mentionFragment('hi @d there')).toBeNull();
  });

  it('lists players by name prefix, spaces written as underscores', () => {
    expect(mentionCandidates('d', players).map((p) => p.name)).toEqual(['dktest', 'Deniz Kaya']);
    expect(mentionCandidates('deniz_', players).map((p) => p.id)).toEqual([7]);
    expect(mentionCandidates('', players)).toEqual(players);
  });

  it('completes @ to the name and # to the player id, adding a space', () => {
    expect(completeMention('hi @d', players, 0)).toBe('hi @dktest ');
    expect(completeMention('hi @de', players, 0)).toBe('hi @Deniz_Kaya ');
    expect(completeMention('!kick #de', players, 0)).toBe('!kick #7 ');
    expect(completeMention('!kick #', players, 2)).toBe('!kick #12 ');
    expect(completeMention('hi @x', players, 0)).toBeNull();
    expect(completeMention('hi', players, 0)).toBeNull();
  });

  it('detects mentions of a name', () => {
    expect(mentions('ping @dktest test', 'dktest')).toBe(true);
    expect(mentions('ping @deniz_kaya', 'Deniz Kaya')).toBe(true);
    expect(mentions('dktest without at', 'dktest')).toBe(false);
  });
});

describe('ChatPanel', () => {
  let session: FakeSession;
  let chat: ChatPanel;
  let sounds: SoundName[];
  let command: ReturnType<typeof vi.fn<(line: string, reply: (text: string) => void) => void>>;

  const lines = () => [...chat.el.querySelectorAll('.dk-chat-line')].map((l) => [l.textContent, l.classList.contains('highlight') ? 'highlight' : l.classList[1]]);
  const key = (k: string) => chat.input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const type = (text: string) => {
    chat.input.value = text;
    chat.input.dispatchEvent(new Event('input'));
  };

  let settings: SettingsStore;

  beforeEach(() => {
    session = new FakeSession(room([player(1, 'dktest', { admin: true }), player(2, 'mira')]));
    sounds = [];
    command = vi.fn((_line: string, reply: (text: string) => void) => reply('Avatar set'));
    settings = createSettingsStore(new MemoryStorage());
    chat = new ChatPanel({ session, settings, command, playSound: (s) => sounds.push(s) });
    document.body.append(chat.el);
  });

  afterEach(() => {
    chat.dispose();
    chat.el.remove();
  });

  it('logs chat with highlight for own name and plays the matching sound', () => {
    session.emit({ type: 'chat', playerId: 2, text: 'hello' });
    session.emit({ type: 'chat', playerId: 2, text: 'ping @dktest test' });
    expect(lines()).toEqual([
      ['mira: hello', 'message'],
      ['mira: ping @dktest test', 'highlight'],
    ]);
    expect(sounds).toEqual(['chat', 'mention']);
  });

  it('writes the observed system notices', () => {
    session.emit({ type: 'playerJoin', player: player(3, 'ode') });
    session.emit({ type: 'setTeam', playerId: 3, team: Team.red, byPlayer: 1, announce: false });
    session.emit({ type: 'setTeam', playerId: 3, team: Team.blue, byPlayer: 1, announce: true });
    session.emit({ type: 'setAdmin', playerId: 3, admin: true, byPlayer: 1 });
    session.emit({ type: 'setAdmin', playerId: 3, admin: false, byPlayer: 1 });
    session.emit({ type: 'startGame', byPlayer: 1 });
    session.emit({ type: 'setPaused', paused: true, byPlayer: 1 });
    session.emit({ type: 'setPaused', paused: false, byPlayer: 1 });
    session.emit({ type: 'stopGame', byPlayer: 1 });
    session.emit({ type: 'stopGame', byPlayer: null });
    session.emit({ type: 'setKickRateLimit', limit: { min: 2, rate: 15, burst: 2 }, byPlayer: 1 });
    session.emit({ type: 'setStadium', source: '{ name: "Tiny", width: 100, height: 50 }', byPlayer: 1 });
    session.emit({ type: 'syncChange', playerId: 3, synced: false });
    session.emit({ type: 'syncChange', playerId: 3, synced: true });
    session.emit({ type: 'playerLeave', playerId: 3, kicked: false, ban: false, reason: '', byPlayer: null });
    const texts = lines().map(([t]) => t);
    expect(texts.slice(0, 9)).toEqual([
      'ode has joined',
      'ode was moved to Blue by dktest',
      'ode was given admin rights',
      "ode's admin rights were taken away",
      'Game started by dktest',
      'Game paused by dktest',
      'Game stopped by dktest',
      'Kick Rate Limit set to (min: 2, rate: 15, burst: 2) by dktest',
      expect.stringMatching(/^Stadium "Tiny" \([0-9A-F]{8}\) loaded by dktest$/),
    ]);
    expect(texts.slice(9)).toEqual(['ode has desynchronized', 'ode is back in sync', 'ode has left']);
    expect(sounds).toEqual(['join', 'leave']);
  });

  it('leaves out joins and plain leaves when join and leave messages are off, but still shows kicks', () => {
    settings.set('joinLeaveNotices', false);
    session.emit({ type: 'playerJoin', player: player(3, 'ode') });
    session.emit({ type: 'playerLeave', playerId: 3, kicked: false, ban: false, reason: '', byPlayer: null });
    session.emit({ type: 'playerLeave', playerId: 2, kicked: true, ban: false, reason: 'spam', byPlayer: 1 });
    expect(lines().map(([t]) => t)).toEqual(['mira was kicked by dktest (spam)']);
    expect(sounds).toEqual(['leave']);
  });

  it("uses the room's team names in notices", () => {
    session.state = { ...session.state, blueName: 'Lions' };
    session.emit({ type: 'setTeam', playerId: 2, team: Team.blue, byPlayer: 1, announce: true });
    session.tick([{ type: 'victory', team: Team.blue }]);
    expect(lines().map(([t]) => t)).toEqual(['mira was moved to Lions by dktest', 'Lions team won the match']);
  });

  it('shows announcements only to their target', () => {
    session.emit({ type: 'announcement', text: 'for mira', targetId: 2, color: -1, style: 'normal', sound: 0 });
    session.emit({ type: 'announcement', text: 'for all', targetId: null, color: 0xff0000, style: 'bold', sound: 2 });
    expect(lines().map(([t]) => t)).toEqual(['for all']);
    expect(chat.el.querySelector<HTMLElement>('.announcement')!.style.color).toBeTruthy();
    expect(sounds).toEqual(['mention']);
  });

  it('sends messages on Enter and routes commands with their reply', () => {
    chat.focus();
    type('hello there');
    key('Enter');
    expect(session.sent).toContainEqual({ type: 'chat', text: 'hello there' });
    expect(chat.input.value).toBe('');
    expect(document.activeElement).not.toBe(chat.input);
    type('/avatar AB');
    key('Enter');
    expect(command).toHaveBeenCalledWith('/avatar AB', expect.any(Function));
    expect(lines().at(-1)).toEqual(['Avatar set', 'notice']);
    expect(session.sent.filter((m) => m.type === 'chat')).toHaveLength(1);
  });

  it('completes mentions with Tab and lists suggestions', () => {
    chat.focus();
    type('hi @m');
    expect([...chat.el.querySelectorAll('.dk-chat-suggestions li')].map((li) => li.textContent)).toEqual(['mira']);
    key('Tab');
    expect(chat.input.value).toBe('hi @mira ');
    expect(chat.el.querySelector<HTMLElement>('.dk-chat-suggestions')!.hidden).toBe(true);
  });

  it('completes # to the selected player id from the same list', () => {
    chat.focus();
    type('!ban #');
    expect([...chat.el.querySelectorAll('.dk-chat-suggestions li')].map((li) => li.textContent)).toEqual(['dktest', 'mira']);
    key('ArrowDown');
    key('Tab');
    expect(chat.input.value).toBe('!ban #2 ');
  });

  it('moves the suggestion selection with the arrow keys and completes the selected name', () => {
    chat.focus();
    type('hi @');
    const selected = () => chat.el.querySelector('.dk-chat-suggestions li.selected')!.textContent;
    expect(selected()).toBe('dktest');
    key('ArrowDown');
    expect(selected()).toBe('mira');
    key('ArrowDown');
    expect(selected()).toBe('dktest');
    key('ArrowUp');
    expect(selected()).toBe('mira');
    key('Tab');
    expect(chat.input.value).toBe('hi @mira ');
  });

  it('resizes the log by dragging the top edge once per frame, clamped, and saves it on release', async () => {
    const handle = chat.el.querySelector<HTMLElement>('.dk-chat-resize')!;
    const pointer = (target: EventTarget, type: string, clientY: number) => target.dispatchEvent(new PointerEvent(type, { clientY, bubbles: true, cancelable: true }));
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const start = settings.get('chatHeight');
    pointer(handle, 'pointerdown', 500);
    expect(chat.el.classList.contains('resizing')).toBe(true);
    pointer(window, 'pointermove', 400);
    await frame();
    expect(chat.el.style.getPropertyValue('--dk-chat-height')).toBe(`${start + 100}px`);
    expect(settings.get('chatHeight')).toBe(start);
    pointer(window, 'pointermove', -10000);
    await frame();
    expect(chat.el.style.getPropertyValue('--dk-chat-height')).toBe(`${Math.round(window.innerHeight * 0.35)}px`);
    pointer(window, 'pointermove', 10000);
    pointer(window, 'pointerup', 0);
    expect(settings.get('chatHeight')).toBe(40);
    expect(chat.el.classList.contains('resizing')).toBe(false);
    pointer(window, 'pointermove', 400);
    expect(settings.get('chatHeight')).toBe(40);
  });

  it('leaves the chat on Tab without a mention', () => {
    chat.focus();
    type('plain');
    key('Tab');
    expect(document.activeElement).not.toBe(chat.input);
  });

  it('requests the typing indicator while text is being written', () => {
    chat.focus();
    type('h');
    type('he');
    chat.input.blur();
    const typing = session.requests().filter((e) => e.type === 'setTyping');
    expect(typing).toEqual([
      { type: 'setTyping', playerId: 1, typing: true },
      { type: 'setTyping', playerId: 1, typing: false },
    ]);
  });

  it('limits input to 140 characters', () => {
    expect(chat.input.maxLength).toBe(140);
  });
});
