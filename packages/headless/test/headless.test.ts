import { decodeReplay } from '@golix/replay';
import { ActionFlags, CollisionFlags, InputFlags, Team, cloneRoom, defaultStadiums, encodeClientMessage } from '@golix/shared';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from '@golix/server';
import { HBInit } from '../src/index.ts';
import { FakePeer, headless, testKey } from './helpers.ts';

const anyPlayer = (fields: object) => expect.objectContaining(fields);

describe('room setup', () => {
  it('calls a global onHBLoaded once the module is ready', async () => {
    const onHBLoaded = vi.fn();
    globalThis.onHBLoaded = onHBLoaded;
    try {
      vi.resetModules();
      await import('../src/index.ts');
      await Promise.resolve();
      expect(onHBLoaded).toHaveBeenCalledOnce();
    } finally {
      globalThis.onHBLoaded = undefined;
    }
  });

  it('maps the original default stadium names onto the built-ins by position', async () => {
    const { room, inner, tick } = await headless();
    ['Classic', 'Easy', 'Small', 'Big', 'Rounded', 'Hockey', 'Big Hockey', 'Big Easy', 'Big Rounded', 'Huge'].forEach((name, i) => {
      room.setDefaultStadium(name);
      tick();
      expect(inner.state.stadiumSource).toBe(defaultStadiums[i].source);
    });
  });

  it('exposes the flag constants and an empty player list without a host player', async () => {
    const { room, tick } = await headless();
    tick();
    expect(room.CollisionFlags).toBe(CollisionFlags);
    expect(room.InputFlags).toEqual({ up: 1, down: 2, left: 4, right: 8, kick: 16 });
    expect(room.getPlayerList()).toEqual([]);
    expect(room.getPlayer(1)).toBeNull();
    expect(room.getScores()).toBeNull();
    expect(room.getBallPosition()).toBeNull();
    expect(room.getDiscCount()).toBe(0);
    expect(room.getDiscProperties(0)).toBeNull();
    expect(() => room.setRequireRecaptcha(true)).not.toThrow();
  });

  it('adds an admin host player unless noPlayer is set, and lets it chat', async () => {
    const { room, tick, join } = await headless({ noPlayer: false, playerName: 'Bot' });
    const onPlayerJoin = vi.fn();
    room.onPlayerJoin = onPlayerJoin;
    tick();
    expect(room.getPlayerList()).toEqual([{ id: 0, name: 'Bot', team: Team.spectators, admin: true, position: null, input: 0, auth: null, conn: null, country: '' }]);
    expect(onPlayerJoin).not.toHaveBeenCalled();

    const alice = join('alice');
    const bob = join('bob');
    room.sendChat('hello all');
    room.sendChat('just you', alice.playerId);
    tick();
    expect(alice.events().filter((e) => e.type === 'chat')).toEqual([
      { type: 'chat', playerId: 0, text: 'hello all' },
      { type: 'chat', playerId: 0, text: 'just you' },
    ]);
    expect(bob.events().filter((e) => e.type === 'chat')).toEqual([{ type: 'chat', playerId: 0, text: 'hello all' }]);
  });

  it('ignores sendChat without a host player', async () => {
    const { room, tick, join } = await headless();
    const alice = join('alice');
    room.sendChat('nobody speaks');
    tick();
    expect(alice.events().some((e) => e.type === 'chat')).toBe(false);
  });
});

describe('players', () => {
  it('fires onPlayerJoin with auth and conn, gives nobody admin, and fires onPlayerLeave', async () => {
    const { room, tick, join } = await headless();
    const onPlayerJoin = vi.fn();
    const onPlayerLeave = vi.fn();
    const onPlayerAdminChange = vi.fn();
    Object.assign(room, { onPlayerJoin, onPlayerLeave, onPlayerAdminChange });
    const alice = join('alice');
    join('bob');
    expect(onPlayerJoin).toHaveBeenNthCalledWith(1, { id: alice.playerId, name: 'alice', team: 0, admin: false, position: null, input: 0, auth: testKey('alice').authId, conn: '', country: 'tr' });
    expect(room.getPlayer(alice.playerId)).toEqual(anyPlayer({ name: 'alice', admin: false, auth: null, conn: null }));
    expect(room.getPlayerList().map((p) => p.name)).toEqual(['alice', 'bob']);

    alice.handle.closed();
    tick();
    expect(onPlayerLeave).toHaveBeenCalledWith(anyPlayer({ id: alice.playerId, name: 'alice' }));
    expect(onPlayerAdminChange).not.toHaveBeenCalled();
    expect(room.getPlayerList().map((p) => p.name)).toEqual(['bob']);
  });

  it('applies state changes on the next tick and passes byPlayer null for host actions', async () => {
    const { room, tick, join } = await headless();
    const onPlayerTeamChange = vi.fn();
    const onPlayerAdminChange = vi.fn();
    Object.assign(room, { onPlayerTeamChange, onPlayerAdminChange });
    const alice = join('alice');
    room.setPlayerTeam(alice.playerId, Team.red);
    room.setPlayerAdmin(alice.playerId, true);
    expect(room.getPlayer(alice.playerId)).toEqual(anyPlayer({ team: Team.spectators, admin: false }));
    tick();
    expect(room.getPlayer(alice.playerId)).toEqual(anyPlayer({ team: Team.red, admin: true }));
    expect(onPlayerTeamChange).toHaveBeenCalledWith(anyPlayer({ id: alice.playerId, team: Team.red }), null);
    expect(onPlayerAdminChange).toHaveBeenCalledWith(anyPlayer({ id: alice.playerId, admin: true }), null);
  });

  it('asks joiners for a captcha on setRequireRecaptcha where the server verifies them, else only limits joins', async () => {
    const rejectionOf = async (captcha: boolean) => {
      const server = await createServer({ port: 0, host: '127.0.0.1', captcha: captcha ? { siteKey: 'k', verify: async () => true } : undefined });
      const room = HBInit({ noPlayer: true, server });
      const [[, inner]] = [...server.rooms];
      room.setRequireRecaptcha(true);
      const reasons = [];
      for (const conn of ['AA', 'AA']) {
        const peer = new FakePeer(inner, conn);
        peer.join(`p${reasons.length}`);
        inner.runTick();
        reasons.push(peer.received[0]?.type === 'joinRejected' ? peer.received[0].reason : 'joined');
      }
      const [listing] = (await (await fetch(`http://127.0.0.1:${server.port}/rooms`)).json()) as { captcha: boolean }[];
      await server.close();
      return [listing!.captcha, ...reasons];
    };
    expect(await rejectionOf(true)).toEqual([true, 'captcha', 'captcha']);
    expect(await rejectionOf(false)).toEqual([false, 'joined', 'rateLimited']);
  });

  it('drops action keys until the script turns them on, then reports each press and release', async () => {
    const { room, inner, tick, join } = await headless();
    const actions: [string, number, boolean][] = [];
    const inputs: number[] = [];
    room.onPlayerAction = (player, actionId, isPressed) => void actions.push([player.name, actionId, isPressed]);
    room.onPlayerInput = (player) => void inputs.push(player.input);
    const alice = join('alice');
    const press = (input: number) => {
      alice.send({ type: 'input', tick: inner.tick + 1, input });
      tick();
    };
    press(ActionFlags[0] | InputFlags.kick);
    expect(actions).toEqual([]);
    expect(inputs).toEqual([InputFlags.kick]);

    room.setActionKeys(true);
    tick();
    press(ActionFlags[0] | ActionFlags[5]);
    press(ActionFlags[5]);
    expect(actions).toEqual([
      ['alice', 1, true],
      ['alice', 6, true],
      ['alice', 1, false],
    ]);
  });

  it('reports bounces with getDiscProperties indexes, and the plane a disc hits', async () => {
    const { room, tick, join } = await headless();
    const discs: [number, number][] = [];
    const planes: [number, number][] = [];
    room.onCollisionDiscVsDisc = (a, b) => void discs.push([a, b]);
    room.onCollisionDiscVsPlane = (d, p) => void planes.push([d, p]);
    const alice = join('alice');
    tick();
    room.setPlayerTeam(alice.playerId, Team.red);
    room.startGame();
    tick();
    const playerDisc = room.getDiscCount() - 1;
    const ball = room.getDiscProperties(0)!;
    room.setPlayerDiscProperties(alice.playerId, { x: ball.x - 30, y: ball.y, xspeed: 3 });
    for (let i = 0; i < 30; i++) tick();
    expect(discs).toContainEqual([0, playerDisc]);
    room.setDiscProperties(0, { x: 0, y: 0, xspeed: 0, yspeed: 40 });
    for (let i = 0; i < 60; i++) tick();
    expect(planes.some(([d]) => d === 0)).toBe(true);
  });

  it('dresses one player in their own kit, with up to five stripes, and takes it off again', async () => {
    const { room, inner, tick, join } = await headless();
    const alice = join('alice');
    room.setPlayerColors(alice.playerId, 30, 0x000000, [1, 2, 3, 4, 5, 6]);
    tick();
    expect(inner.state.players[0].colors).toEqual({ angle: 30, textColor: 0, colors: [1, 2, 3, 4, 5] });
    alice.request({ type: 'setPlayerColors', playerId: alice.playerId, colors: null });
    tick();
    expect(inner.state.players[0].colors).toBeDefined();
    room.clearPlayerColors(alice.playerId);
    tick();
    expect(inner.state.players[0].colors).toBeUndefined();
  });

  it('passes the acting player as byPlayer for player requests', async () => {
    const { room, tick, join } = await headless();
    const onPlayerTeamChange = vi.fn();
    room.onPlayerTeamChange = onPlayerTeamChange;
    const alice = join('alice');
    const bob = join('bob');
    room.setPlayerAdmin(alice.playerId, true);
    tick();
    alice.request({ type: 'setTeam', playerId: bob.playerId, team: Team.blue, byPlayer: null, announce: false });
    tick();
    expect(onPlayerTeamChange).toHaveBeenCalledWith(anyPlayer({ id: bob.playerId, team: Team.blue }), anyPlayer({ id: alice.playerId, admin: true }));
  });

  it('kicks and bans, firing onPlayerLeave before onPlayerKicked, and clears a single ban', async () => {
    const { room, tick, join } = await headless();
    const calls: string[] = [];
    const onPlayerKicked = vi.fn(() => calls.push('kicked'));
    room.onPlayerLeave = () => calls.push('leave');
    room.onPlayerKicked = onPlayerKicked;
    const alice = join('alice');
    room.kickPlayer(alice.playerId, 'spam', true);
    tick();
    expect(calls).toEqual(['leave', 'kicked']);
    expect(onPlayerKicked).toHaveBeenCalledWith(anyPlayer({ name: 'alice' }), 'spam', true, null);
    expect(alice.last('disconnected')).toEqual({ type: 'disconnected', reason: 'banned' });

    const again = join('alice');
    expect(again.last('joinRejected')).toEqual({ type: 'joinRejected', reason: 'banned' });
    room.clearBan(alice.playerId);
    tick();
    expect(join('alice').last('welcome')).toBeDefined();
  });

  it('clears all bans', async () => {
    const { room, tick, join } = await headless();
    const alice = join('alice');
    const bob = join('bob');
    room.kickPlayer(alice.playerId, '', true);
    room.kickPlayer(bob.playerId, '', true);
    tick();
    room.clearBans();
    tick();
    expect(join('alice').last('welcome')).toBeDefined();
    expect(join('bob').last('welcome')).toBeDefined();
  });

  it('reorders players', async () => {
    const { room, tick, join } = await headless();
    const [a, b, c] = ['a', 'b', 'c'].map((n) => join(n).playerId);
    room.reorderPlayers([c], true);
    tick();
    expect(room.getPlayerList().map((p) => p.id)).toEqual([c, a, b]);
    room.reorderPlayers([c, a], false);
    tick();
    expect(room.getPlayerList().map((p) => p.id)).toEqual([b, c, a]);
  });

  it('overrides an avatar and gives the player the one they chose meanwhile when cleared', async () => {
    const { room, inner, tick, join } = await headless();
    const alice = join('alice');
    room.setPlayerAvatar(alice.playerId, 'XYZ');
    tick();
    const avatar = () => inner.state.players.find((p) => p.id === alice.playerId)?.avatar;
    expect(avatar()).toBe('XY');
    alice.request({ type: 'setAvatar', playerId: alice.playerId, avatar: 'A' });
    tick();
    expect(avatar()).toBe('XY');
    room.setPlayerAvatar(alice.playerId, null);
    tick();
    expect(avatar()).toBe('A');
    alice.request({ type: 'setAvatar', playerId: alice.playerId, avatar: 'B' });
    tick();
    expect(avatar()).toBe('B');
  });

  it('reports input changes and activity', async () => {
    const { room, inner, tick, join } = await headless();
    const onPlayerInput = vi.fn();
    const onPlayerActivity = vi.fn();
    Object.assign(room, { onPlayerInput, onPlayerActivity });
    const alice = join('alice');
    room.setPlayerTeam(alice.playerId, Team.red);
    room.startGame();
    tick();
    alice.send({ type: 'input', tick: inner.tick + 1, input: InputFlags.up | InputFlags.kick });
    tick();
    expect(onPlayerActivity).toHaveBeenCalledWith(anyPlayer({ id: alice.playerId }));
    expect(onPlayerInput).toHaveBeenCalledWith(anyPlayer({ id: alice.playerId, input: 17 }), 0);
    expect(room.getPlayer(alice.playerId)?.input).toBe(17);
  });
});

describe('chat and announcements', () => {
  it('drops a player message when onPlayerChat returns false', async () => {
    const { room, tick, join } = await headless();
    const onPlayerChat = vi.fn((_player: unknown, message: string) => message !== 'bad word');
    room.onPlayerChat = onPlayerChat;
    const alice = join('alice');
    const bob = join('bob');
    alice.send({ type: 'chat', text: 'bad word' });
    alice.send({ type: 'chat', text: 'hello' });
    tick();
    expect(onPlayerChat).toHaveBeenNthCalledWith(1, anyPlayer({ id: alice.playerId, name: 'alice' }), 'bad word');
    expect(bob.events().filter((e) => e.type === 'chat')).toEqual([{ type: 'chat', playerId: alice.playerId, text: 'hello' }]);
  });

  it('sends announcements with defaults or the given color, style and sound, to everyone or one player', async () => {
    const { room, tick, join } = await headless();
    const alice = join('alice');
    const bob = join('bob');
    room.sendAnnouncement('welcome');
    room.sendAnnouncement('psst', bob.playerId, 0xff0000, 'small-bold', 2);
    tick();
    const announcements = (peer: typeof alice) => peer.events().filter((e) => e.type === 'announcement');
    expect(announcements(alice)).toEqual([{ type: 'announcement', text: 'welcome', targetId: null, color: -1, style: 'normal', sound: 1 }]);
    expect(announcements(bob)).toEqual([
      { type: 'announcement', text: 'welcome', targetId: null, color: -1, style: 'normal', sound: 1 },
      { type: 'announcement', text: 'psst', targetId: bob.playerId, color: 0xff0000, style: 'small-bold', sound: 2 },
    ]);
  });
});

describe('room settings', () => {
  it('sets limits, stadiums, lock, colors and kick rate limit with their events', async () => {
    const { room, inner, tick } = await headless();
    const onStadiumChange = vi.fn();
    const onTeamsLockChange = vi.fn();
    const onKickRateLimitSet = vi.fn();
    Object.assign(room, { onStadiumChange, onTeamsLockChange, onKickRateLimitSet });
    room.setScoreLimit(5);
    room.setTimeLimit(0);
    room.setDefaultStadium(defaultStadiums[2].name);
    room.setDefaultStadium('Easy');
    room.setDefaultStadium(defaultStadiums[2].name.toLowerCase());
    room.setTeamsLock(true);
    room.setTeamColors(Team.red, 60, 0xffffff, [0xff0000, 0x00ff00, 0x0000ff, 0x123456]);
    room.setKickRateLimit();
    room.setKickRateLimit(1, 15, 3);
    tick();
    expect(inner.state).toEqual(expect.objectContaining({ scoreLimit: 5, timeLimit: 0, teamsLock: true, stadiumSource: defaultStadiums[1].source }));
    expect(inner.state.redColors).toEqual({ angle: 60, textColor: 0xffffff, colors: [0xff0000, 0x00ff00, 0x0000ff, 0x123456] });
    expect(onStadiumChange.mock.calls).toEqual([[defaultStadiums[2].name, null], [defaultStadiums[1].name, null]]);
    expect(onTeamsLockChange).toHaveBeenCalledWith(true, null);
    expect(onKickRateLimitSet.mock.calls).toEqual([
      [2, 0, 0, null],
      [1, 15, 3, null],
    ]);
  });

  it('loads a custom stadium, throws on a broken one and ignores stadium and limit changes during a game', async () => {
    const { room, inner, tick } = await headless();
    const onStadiumChange = vi.fn();
    room.onStadiumChange = onStadiumChange;
    const custom = defaultStadiums[0].source.replace("name: 'Standard'", "name: 'Custom'");
    room.setCustomStadium(custom);
    tick();
    expect(onStadiumChange).toHaveBeenCalledWith('Custom', null);
    expect(() => room.setCustomStadium('{ width: ')).toThrow();

    room.startGame();
    tick();
    room.setDefaultStadium(defaultStadiums[1].name);
    room.setScoreLimit(9);
    tick();
    expect(inner.state.stadiumSource).toBe(custom);
    expect(inner.state.scoreLimit).toBe(3);
  });

  it('sets and clears the password', async () => {
    const { room, inner, tick, join } = await headless({ password: 'first' });
    expect(join('alice').last('joinRejected')).toEqual({ type: 'joinRejected', reason: 'password' });
    expect(join('alice', { password: 'first' }).last('welcome')).toBeDefined();
    room.setPassword('second');
    tick();
    expect(join('bob', { password: 'second' }).last('welcome')).toBeDefined();
    room.setPassword(null);
    tick();
    expect(inner.state.hasPassword).toBe(false);
    expect(join('carol').last('welcome')).toBeDefined();
  });
});

describe('game flow', () => {
  it('starts, ticks, pauses, unpauses and stops the game', async () => {
    const { room, tick, join } = await headless();
    const events: string[] = [];
    let ticks = 0;
    room.onGameStart = (by) => events.push(`start ${by}`);
    room.onGameStop = (by) => events.push(`stop ${by}`);
    room.onGamePause = (by) => events.push(`pause ${by}`);
    room.onGameUnpause = (by) => events.push(`unpause ${by}`);
    room.onGameTick = () => ticks++;
    const alice = join('alice');
    room.setPlayerTeam(alice.playerId, Team.red);
    tick();
    room.startGame();
    room.startGame();
    tick();
    expect(events).toEqual(['start null']);
    expect(ticks).toBe(1);
    expect(room.getScores()).toEqual({ red: 0, blue: 0, time: 0, scoreLimit: 3, timeLimit: 180 });
    expect(room.getBallPosition()).toEqual({ x: 0, y: 0 });
    expect(room.getPlayer(alice.playerId)?.position).toEqual({ x: expect.any(Number), y: 0 });

    room.pauseGame(true);
    room.pauseGame(true);
    tick(10);
    expect(events).toEqual(['start null', 'pause null']);
    expect(ticks).toBe(1);
    room.pauseGame(false);
    tick(119);
    expect(events.at(-1)).toBe('unpause null');
    expect(ticks).toBe(1);
    tick();
    expect(ticks).toBe(2);

    room.stopGame();
    room.stopGame();
    tick();
    expect(events.at(-1)).toBe('stop null');
    expect(events.filter((e) => e.startsWith('stop'))).toHaveLength(1);
    expect(room.getScores()).toBeNull();
  });

  it('reports kicks, goals and position resets', async () => {
    const { room, inner, tick, join } = await headless();
    const onPlayerBallKick = vi.fn();
    const onTeamGoal = vi.fn();
    const onPositionsReset = vi.fn();
    Object.assign(room, { onPlayerBallKick, onTeamGoal, onPositionsReset });
    const alice = join('alice');
    room.setPlayerTeam(alice.playerId, Team.red);
    tick();
    room.startGame();
    tick();
    room.setDiscProperties(0, { x: 340, y: 0, xspeed: 0, yspeed: 0 });
    room.setPlayerDiscProperties(alice.playerId, { x: 315, y: 0, xspeed: 0, yspeed: 0 });
    alice.send({ type: 'input', tick: inner.tick + 1, input: InputFlags.kick });
    tick();
    expect(onPlayerBallKick).toHaveBeenCalledWith(anyPlayer({ id: alice.playerId, country: 'tr' }), [0]);
    tick(30);
    expect(onTeamGoal).toHaveBeenCalledExactlyOnceWith(Team.red);
    expect(room.getScores()).toEqual(expect.objectContaining({ red: 1, blue: 0 }));
    tick(150);
    expect(onPositionsReset).toHaveBeenCalledOnce();
  });

  it('reports a kick pressed while the kick rate limit has none left', async () => {
    const { room, inner, tick, join } = await headless();
    const onKickRateLimitReached = vi.fn();
    room.onKickRateLimitReached = onKickRateLimitReached;
    const alice = join('alice');
    room.setPlayerTeam(alice.playerId, Team.red);
    room.setKickRateLimit(0, 60, 1);
    room.startGame();
    tick();
    const press = () => {
      room.setDiscProperties(0, { x: 0, y: 0, xspeed: 0, yspeed: 0 });
      room.setPlayerDiscProperties(alice.playerId, { x: -25, y: 0, xspeed: 0, yspeed: 0 });
      alice.send({ type: 'input', tick: inner.tick + 1, input: InputFlags.kick });
      tick();
      alice.send({ type: 'input', tick: inner.tick + 1, input: 0 });
      tick();
    };
    press();
    expect(onKickRateLimitReached).not.toHaveBeenCalled();
    press();
    expect(onKickRateLimitReached).toHaveBeenCalledExactlyOnceWith(anyPlayer({ id: alice.playerId }));
  });

  it('renames the room and a team, rewrites the running game and ties joints that can break', async () => {
    const { room, inner, tick, join } = await headless();
    const onJointBreak = vi.fn();
    room.onJointBreak = onJointBreak;
    const alice = join('alice');
    room.setRoomName('League night');
    room.setMaxPlayers(4);
    room.setTeamName(Team.blue, 'Lions');
    room.setPlayerTeam(alice.playerId, Team.red);
    room.startGame();
    tick();
    expect(inner.state).toMatchObject({ name: 'League night', maxPlayers: 4, blueName: 'Lions' });
    room.setGameProperties({ red: 2, timeLimit: 9 });
    room.addJoint({ d0: { discIndex: 0 }, d1: { playerId: alice.playerId }, breakLength: 400 });
    tick();
    expect(room.getScores()).toEqual(expect.objectContaining({ red: 2, blue: 0, timeLimit: 540 }));
    expect(room.getJointCount()).toBe(1);
    room.setPlayerDiscProperties(alice.playerId, { x: -600 });
    tick();
    expect(onJointBreak).toHaveBeenCalledExactlyOnceWith(0);
    expect(room.getJointCount()).toBe(0);
  });

  it('round-trips disc properties for the ball, stadium discs and player discs', async () => {
    const { room, tick, join } = await headless();
    const alice = join('alice');
    room.setPlayerTeam(alice.playerId, Team.blue);
    room.startGame();
    tick();
    room.pauseGame(true);
    tick();
    const stadiumDiscs = room.getDiscCount() - 1;
    const props = { x: 12, y: -7, xspeed: 1.5, yspeed: -2, xgravity: 0.01, ygravity: 0.02, radius: 9, bCoeff: 0.7, invMass: 2, damping: 0.98, color: 0xff00ff, cMask: CollisionFlags.wall, cGroup: CollisionFlags.ball | CollisionFlags.c0 };
    room.setDiscProperties(0, props);
    room.setPlayerDiscProperties(alice.playerId, { x: 0.4, radius: 20 });
    room.setDiscProperties(stadiumDiscs, { y: 33 });
    expect(room.getDiscProperties(0)?.x).toBe(0);
    tick();
    expect(room.getDiscProperties(0)).toEqual({ ...props, xgravity: Math.fround(0.01), ygravity: Math.fround(0.02), bCoeff: Math.fround(0.7), damping: Math.fround(0.98) });
    expect(room.getDiscProperties(0)?.bCoeff).toBe(0.699999988079071);
    const own = room.getPlayerDiscProperties(alice.playerId);
    expect(own).toEqual(expect.objectContaining({ x: 0.4000000059604645, y: 33, radius: 20 }));
    expect(room.getDiscProperties(stadiumDiscs)).toEqual(own);
    expect(room.getDiscProperties(stadiumDiscs + 1)).toBeNull();
    expect(room.getPlayerDiscProperties(999)).toBeNull();
  });

  it('records a replay that starts after the current tick', async () => {
    const { room, inner, tick, join } = await headless();
    expect(room.stopRecording()).toBeNull();
    room.startRecording();
    tick();
    const start = cloneRoom(inner.state);
    join('alice');
    tick();
    const bytes = room.stopRecording();
    if (bytes === null) throw new Error('no replay');
    const replay = decodeReplay(bytes);
    expect(replay.start).toEqual(start);
    expect(replay.frames).toEqual([
      { kind: 'events', events: [expect.objectContaining({ type: 'playerJoin' })] },
      { kind: 'events', events: [] },
    ]);
    expect(room.stopRecording()).toBeNull();
  });
});

describe('over the network', () => {
  it('starts on a given server, lists public rooms and reports the connection of a real client', async () => {
    const server = await createServer({ port: 0, host: '127.0.0.1' });
    try {
      const room = HBInit({ roomName: 'Net room', noPlayer: true, server });
      const link = await new Promise<string>((resolve) => (room.onRoomLink = resolve));
      const id = new URL(link).searchParams.get('c');
      const listed = (await (await fetch(`http://127.0.0.1:${server.port}/rooms`)).json()) as { id: string; name: string }[];
      expect(listed).toEqual([expect.objectContaining({ id, name: 'Net room' })]);

      const joined = new Promise<{ name: string; conn: string | null }>((resolve) => (room.onPlayerJoin = resolve));
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/room/${id}`);
      await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
      ws.send(encodeJoin('dana'));
      const player = await joined;
      expect(player.name).toBe('dana');
      expect(Buffer.from(player.conn ?? '', 'hex').toString()).toContain('127.0.0.1');
      ws.close();
    } finally {
      await server.close();
    }
  });

  it('reports the room link once the room is served, after the handlers are set', async () => {
    const server = await createServer({ port: 0, host: '127.0.0.1' });
    try {
      const room = HBInit({ password: 'pw', clientUrl: 'https://play.example', server });
      const onRoomLink = vi.fn();
      room.onRoomLink = onRoomLink;
      await Promise.resolve();
      const [id] = server.rooms.keys();
      expect(id).toHaveLength(11);
      expect(onRoomLink).toHaveBeenCalledWith(`https://play.example/play?c=${id}&p=1`);
    } finally {
      await server.close();
    }
  });

  it('keeps private rooms out of the room list', async () => {
    const server = await createServer({ port: 0, host: '127.0.0.1' });
    try {
      HBInit({ public: false, noPlayer: true, server });
      expect(await (await fetch(`http://127.0.0.1:${server.port}/rooms`)).json()).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

function encodeJoin(name: string): Uint8Array<ArrayBuffer> {
  return encodeClientMessage({ type: 'join', name, avatar: '', country: 'tr', password: '', auth: name, signature: '', verified: '' });
}
