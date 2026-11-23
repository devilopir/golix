// @vitest-environment happy-dom
import { Team } from '@golix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomMods } from '../../src/ui/modPanel.ts';
import { RoomScreen } from '../../src/ui/roomScreen.ts';
import { StadiumStore } from '../../src/ui/stadiums.ts';
import { autoAssign, canSelfMove, randomizeTeams } from '../../src/ui/teams.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { click, FakeSession, findButton, game, player, room } from './fakes.ts';

function setup(admin: boolean, overrides: Parameters<typeof room>[1] = {}, mods: RoomMods | null = null) {
  const session = new FakeSession(
    room(
      [
        player(1, 'self', { admin }),
        player(2, 'red one', { team: Team.red }),
        player(3, 'blue one', { team: Team.blue }),
        player(4, 'spec'),
      ],
      overrides,
    ),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const onLeave = vi.fn();
  const onRecord = vi.fn();
  const screen = new RoomScreen({
    session,
    stadiums: new StadiumStore(new MemoryStorage()),
    host,
    roomLink: 'https://example.test/play?c=abc',
    random: () => 0,
    download: vi.fn(),
    onLeave,
    onRecord,
    mods,
  });
  host.append(screen.el);
  const header = (team: string) => [...screen.el.querySelectorAll<HTMLButtonElement>('.dk-team-header')].find((b) => b.textContent === team)!;
  const column = (team: string) => screen.el.querySelector<HTMLElement>(`.dk-team-${team.toLowerCase()}`)!;
  const row = (id: number) => screen.el.querySelector<HTMLElement>(`[data-player-id="${id}"]`)!;
  return { session, host, screen, header, column, row, onLeave, onRecord };
}

describe('team helpers', () => {
  const r = (players: ReturnType<typeof player>[], overrides = {}) => room(players, overrides);

  it('allows self moves only between matches and, when locked, only for admins', () => {
    expect(canSelfMove(r([player(1, 'a')]), 1)).toBe(true);
    expect(canSelfMove(r([player(1, 'a')], { teamsLock: true }), 1)).toBe(false);
    expect(canSelfMove(r([player(1, 'a', { admin: true })], { teamsLock: true }), 1)).toBe(true);
    expect(canSelfMove(r([player(1, 'a', { admin: true })], { game: game() }), 1)).toBe(false);
  });

  it('Rand deals spectators out too', () => {
    expect(randomizeTeams(r([player(1, 'a', { team: Team.red }), player(2, 'b')]), () => 0.99)).toEqual([{ playerId: 2, team: Team.blue }]);
    expect(randomizeTeams(r([player(1, 'a'), player(2, 'b')]), () => 0.99)).toEqual([
      { playerId: 1, team: Team.red },
      { playerId: 2, team: Team.blue },
    ]);
    expect(randomizeTeams(r([player(1, 'a', { team: Team.red }), player(2, 'b', { team: Team.blue })]), () => 0.99)).toEqual([]);
  });

  it('Auto balances from the top of the spectator list', () => {
    expect(autoAssign(r([player(1, 'a')]))).toEqual([]);
    expect(autoAssign(r([player(1, 'a'), player(2, 'b')]))).toEqual([
      { playerId: 1, team: Team.red },
      { playerId: 2, team: Team.blue },
    ]);
    expect(autoAssign(r([player(1, 'a', { team: Team.red }), player(2, 'b')]))).toEqual([{ playerId: 2, team: Team.blue }]);
  });
});

describe('RoomScreen', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('lists players in Red | Spectators | Blue', () => {
    const { column, screen } = setup(true);
    expect(screen.el.querySelector('h1')!.textContent).toBe('Test room');
    expect(column('red').textContent).toContain('red one');
    expect(column('spectators').textContent).toContain('self');
    expect(column('spectators').textContent).toContain('spec');
    expect(column('blue').textContent).toContain('blue one');
  });

  it('hides admin controls from non-admins and shows the limits read-only', () => {
    const { screen } = setup(false, { timeLimit: 5, scoreLimit: 2 });
    for (const label of ['Auto', 'Rand', 'Lock', 'Reset', 'Start game', 'Pick', '▶', '◀']) expect(findButton(screen.el, label).hidden).toBe(true);
    expect([...screen.el.querySelectorAll('select')].every((s) => s.hidden)).toBe(true);
    const shown = [...screen.el.querySelectorAll<HTMLElement>('.dk-room-footer .dk-field > span:not(:first-child)')].filter((el) => !el.hidden);
    expect(shown.map((el) => el.textContent).slice(0, 2)).toEqual(['5', '2']);
    expect(findButton(screen.el, 'Rec').disabled).toBe(false);
    expect(findButton(screen.el, 'Link').disabled).toBe(false);
  });

  it('lets a player join a team by its header unless locked or in a match', () => {
    const { session, header, screen } = setup(false);
    header('Red').click();
    expect(session.requests()).toEqual([{ type: 'setTeam', playerId: 1, team: Team.red, byPlayer: 1, announce: false }]);
    session.state.teamsLock = true;
    session.emit({ type: 'setTeamsLock', locked: true, byPlayer: 2 });
    expect(header('Blue').disabled).toBe(true);
    session.state.teamsLock = false;
    session.state.game = game();
    screen.update();
    expect(header('Blue').disabled).toBe(true);
  });

  it('admins still pick a team while locked', () => {
    const { session, header } = setup(true, { teamsLock: true });
    expect(header('Blue').disabled).toBe(false);
    header('Blue').click();
    expect(session.requests()).toEqual([{ type: 'setTeam', playerId: 1, team: Team.blue, byPlayer: 1, announce: false }]);
  });

  it('redraws once per tick however many events the tick carries', () => {
    const { session, screen } = setup(true);
    const update = vi.spyOn(screen, 'update');
    session.emit(...Array.from({ length: 200 }, () => ({ type: 'setTyping' as const, playerId: 2, typing: true })));
    expect(update).toHaveBeenCalledTimes(1);
    session.tick([]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('Lock toggles and relabels', () => {
    const { session, screen } = setup(true);
    click(screen.el, 'Lock');
    expect(session.requests()).toEqual([{ type: 'setTeamsLock', locked: true, byPlayer: 1 }]);
    session.state.teamsLock = true;
    session.emit({ type: 'setTeamsLock', locked: true, byPlayer: 1 });
    expect(findButton(screen.el, 'Unlock')).toBeTruthy();
  });

  it('Reset and the arrows move players to Spectators', () => {
    const { session, screen } = setup(true);
    click(screen.el, 'Reset');
    expect(session.requests()).toEqual([
      { type: 'setTeam', playerId: 2, team: Team.spectators, byPlayer: 1, announce: false },
      { type: 'setTeam', playerId: 3, team: Team.spectators, byPlayer: 1, announce: false },
    ]);
    session.sent.length = 0;
    click(screen.el, '◀');
    expect(session.requests()).toEqual([{ type: 'setTeam', playerId: 3, team: Team.spectators, byPlayer: 1, announce: false }]);
  });

  it('Rand requests the shuffled teams', () => {
    const { session, screen } = setup(true);
    session.state.players[3].team = Team.red;
    click(screen.el, 'Rand');
    expect(session.requests()).toEqual([{ type: 'setTeam', playerId: 1, team: Team.blue, byPlayer: 1, announce: false }]);
  });

  it('drag and drop by an admin moves a player, also during a match', () => {
    const { session, screen, row, column } = setup(true);
    session.state.game = game();
    screen.update();
    row(4).dispatchEvent(new Event('dragstart'));
    const over = new Event('dragover', { cancelable: true });
    column('blue').dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    column('blue').dispatchEvent(new Event('drop', { cancelable: true }));
    expect(session.requests()).toEqual([{ type: 'setTeam', playerId: 4, team: Team.blue, byPlayer: 1, announce: true }]);
  });

  it('ignores drags from non-admins and drops on the same team', () => {
    const admin = setup(true);
    admin.row(2).dispatchEvent(new Event('dragstart'));
    admin.column('red').dispatchEvent(new Event('drop', { cancelable: true }));
    expect(admin.session.requests()).toEqual([]);
    document.body.replaceChildren();
    const { session, row, column } = setup(false);
    const start = new Event('dragstart', { cancelable: true });
    row(4).dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    column('red').dispatchEvent(new Event('drop', { cancelable: true }));
    expect(session.requests()).toEqual([]);
  });

  it('lets an admin drag a player to a team with a finger, while a tap or a move off the columns does nothing', () => {
    const { session, screen, row, column } = setup(true);
    const touch = (type: string, x: number, target: EventTarget = window) =>
      target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 7, clientX: x, clientY: 0, bubbles: true }));
    const under = vi.spyOn(document, 'elementFromPoint');

    touch('pointerdown', 0, row(4));
    touch('pointerup', 0);
    expect(session.requests()).toEqual([]);

    under.mockReturnValue(column('blue').querySelector('ul'));
    touch('pointerdown', 0, row(4));
    touch('pointermove', 50);
    expect(column('blue').classList.contains('drop-target')).toBe(true);
    screen.update();
    touch('pointerup', 50);
    expect(column('blue').classList.contains('drop-target')).toBe(false);
    expect(session.requests()).toEqual([{ type: 'setTeam', playerId: 4, team: Team.blue, byPlayer: 1, announce: true }]);

    under.mockReturnValue(document.body);
    touch('pointerdown', 0, row(2));
    touch('pointermove', 50);
    touch('pointerup', 50);
    expect(session.requests()).toHaveLength(1);
    under.mockRestore();
  });

  it('switches Start to Stop and Pause/Resume in a match and locks limits and stadium', () => {
    const { session, screen } = setup(true);
    click(screen.el, 'Start game');
    expect(session.requests()).toEqual([{ type: 'startGame', byPlayer: 1 }]);
    session.state.game = game();
    session.emit({ type: 'startGame', byPlayer: 1 });
    expect(findButton(screen.el, 'Start game').hidden).toBe(true);
    expect(findButton(screen.el, 'Pick').disabled).toBe(true);
    expect([...screen.el.querySelectorAll('select')].every((s) => s.disabled)).toBe(true);
    click(screen.el, 'Pause (P)');
    session.state.game = game(120);
    session.emit({ type: 'setPaused', paused: true, byPlayer: 1 });
    click(screen.el, 'Resume (P)');
    click(screen.el, 'Stop game');
    expect(session.requests().slice(1)).toEqual([
      { type: 'setPaused', paused: true, byPlayer: 1 },
      { type: 'setPaused', paused: false, byPlayer: 1 },
      { type: 'stopGame', byPlayer: 1 },
    ]);
  });

  it('sends limit changes', () => {
    const { session, screen } = setup(true);
    const [time, score] = screen.el.querySelectorAll('select');
    time.value = '7';
    time.dispatchEvent(new Event('change'));
    score.value = '0';
    score.dispatchEvent(new Event('change'));
    expect(session.requests()).toEqual([
      { type: 'setTimeLimit', value: 7, byPlayer: 1 },
      { type: 'setScoreLimit', value: 0, byPlayer: 1 },
    ]);
  });

  it('opens the player menu for admins on a right click on other rows', () => {
    const { session, host, row } = setup(true);
    const rightClick = (id: number) => row(id).dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    rightClick(1);
    row(2).click();
    expect(host.querySelector('.dk-player-menu')).toBeNull();
    rightClick(2);
    expect([...host.querySelectorAll('.dk-player-menu button')].map((b) => b.textContent)).toEqual(['Give Admin', 'Kick', 'Close']);
    click(host, 'Close');
    expect(host.querySelector('.dk-player-menu')).toBeNull();
    rightClick(2);
    click(host, 'Give Admin');
    rightClick(2);
    click(host, 'Kick');
    const reason = host.querySelector<HTMLInputElement>('.dk-dialog input')!;
    expect(reason.maxLength).toBe(100);
    reason.value = 'spam';
    click(host, 'No');
    click(host, 'Kick');
    expect(session.requests()).toEqual([
      { type: 'setAdmin', playerId: 2, admin: true, byPlayer: 1 },
      { type: 'playerLeave', playerId: 2, kicked: true, ban: true, reason: 'spam', byPlayer: 1 },
    ]);
  });

  it('kick dialog toggles the ban flag', () => {
    const { session, host, row } = setup(true);
    row(3).dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    click(host, 'Kick');
    click(host, 'No');
    click(host, 'Yes');
    click(host, 'Kick');
    expect(session.requests()).toEqual([{ type: 'playerLeave', playerId: 3, kicked: true, ban: false, reason: '', byPlayer: 1 }]);
  });

  it('non-admins get no player menu', () => {
    const { host, row } = setup(false);
    row(2).dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    expect(host.querySelector('.dk-player-menu')).toBeNull();
  });

  it('shows the link and leave dialogs', () => {
    const { host, screen, onLeave } = setup(false);
    click(screen.el, 'Link');
    expect(host.textContent).toContain('Use this url to link others directly into this room.');
    expect(host.querySelector<HTMLInputElement>('.dk-dialog input')!.value).toBe('https://example.test/play?c=abc');
    click(host, 'Close');
    click(screen.el, 'Leave');
    expect(host.textContent).toContain('Are you sure you want to leave the room?');
    click(host.querySelector('.dk-dialog')!, 'Leave');
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it('Rec toggles recording', () => {
    const { screen, onRecord } = setup(false);
    click(screen.el, 'Rec');
    click(screen.el, 'Rec');
    expect(onRecord.mock.calls).toEqual([[true], [false]]);
  });
});

describe('mods button', () => {
  it('shows only in rooms this browser hosts and opens the panel', () => {
    expect([...setup(true).screen.el.querySelectorAll('button')].some((b) => b.textContent === 'Mods')).toBe(false);
    const session = new FakeSession(room([player(1, 'self', { admin: true })]));
    const { host, screen } = setup(true, {}, new RoomMods(session, () => {}));
    click(screen.el, 'Mods');
    expect(host.querySelector('.dk-mod-panel h2')?.textContent).toBe('Mods');
  });
});
