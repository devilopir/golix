import { Team, type GameState } from '@golix/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { arcCounterClockwise, createRenderer, followed, kickHighlight } from '../../src/render/renderer.ts';
import type { RenderFrame } from '../../src/render/types.ts';
import { defaultTheme } from '../../src/theme/index.ts';
import { createFakeCanvas } from './fakeCanvas.ts';
import { defaultView, makeGame, makeRoom, player } from './fixtures.ts';

function renderOnce(game: GameState, extra: Partial<RenderFrame> = {}, lowLatency = true) {
  const fake = createFakeCanvas(800, 450);
  const renderer = createRenderer(fake.element, defaultTheme, lowLatency);
  renderer.render({
    prev: game,
    curr: game,
    alpha: 0,
    room: makeRoom(game),
    localPlayerId: 1,
    view: defaultView,
    typingPlayerIds: new Set([2]),
    menuOpen: false,
    ...extra,
  });
  return fake;
}

const texts = (log: string[]) => log.filter((l) => l.startsWith('main.fillText('));

afterEach(() => {
  delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
});

describe('renderer draw calls', () => {
  it('kickoff, without the local player\'s own name', () => {
    const { log } = renderOnce(makeGame());
    expect(log[0]).toBe('main.getContext("2d", {"desynchronized":true,"alpha":false})');
    expect(texts(log)).toEqual([
      'main.fillText("Bora", 170, 27)',
      'main.fillText("1", 0, 5.578)',
      'main.fillText("GK", 0, 5.578)',
      'main.fillText("0", 340, 30)',
      'main.fillText("0", 460, 30)',
      'main.fillText("00:00", 400, 30)',
    ]);
    expect(log).toMatchSnapshot();
  });

  it('uses the theme colors for a team whose room colors are not set', () => {
    const game = makeGame();
    const room = { ...makeRoom(game), redColors: { angle: 0, textColor: 0xffffff, colors: [] } };
    const { log } = renderOnce(game, { room });
    expect(log).toContain(`main.fillStyle = "#${defaultTheme.teams.red.colors[0]!.toString(16)}"`);
  });

  it("draws a player's own kit instead of the team's, unless custom colors are off", () => {
    const game = makeGame();
    const base = makeRoom(game);
    const room = { ...base, players: base.players.map((p) => (p.id === 1 ? { ...p, colors: { angle: 0, textColor: 0x00ff00, colors: [0x123456, 0x654321] } } : p)) };
    const textColorOf = (log: string[], label: string) => log.slice(0, log.indexOf(`main.fillText("${label}", 0, 5.578)`)).reverse().find((l) => l.startsWith('main.fillStyle'));
    const own = renderOnce(game, { room }).log;
    expect(own.some((l) => l.endsWith('.fillStyle = "#654321"'))).toBe(true);
    expect(textColorOf(own, '1')).toBe('main.fillStyle = "#00ff00"');
    const off = renderOnce(game, { room, view: { ...defaultView, customTeamColors: false } }).log;
    expect(off.some((l) => l.endsWith('.fillStyle = "#654321"'))).toBe(false);
  });

  it('kicking player highlight', () => {
    const base = makeGame();
    const game = makeGame({ phase: 'playing', players: [player(1, Team.red, { x: -20, y: 0 }, { kicking: true }), base.players[1]!] });
    const { log } = renderOnce(game);
    expect(log).toContain(`main.strokeStyle = "${defaultTheme.player.kickOutline}"`);
    expect(log).toMatchSnapshot();
  });

  it('goal text', () => {
    const { log } = renderOnce(makeGame({ phase: 'goal', phaseTicks: 30, red: 1, scoringTeam: Team.red, time: 3725 / 60 }));
    expect(texts(log)).toContain('main.fillText("Red Scores!", 0, 0)');
    expect(texts(log)).toContain('main.fillText("01:02", 400, 30)');
    expect(log).toMatchSnapshot();
  });

  it('victory text only from 0.2 s to 2.5 s into the ended phase', () => {
    const victory = (phaseTicks: number) => texts(renderOnce(makeGame({ phase: 'ended', phaseTicks, blue: 3, winner: Team.blue })).log);
    expect(victory(11)).not.toContain('main.fillText("Blue is Victorious!", 0, 0)');
    expect(victory(149)).toContain('main.fillText("Blue is Victorious!", 0, 0)');
    expect(victory(150)).not.toContain('main.fillText("Blue is Victorious!", 0, 0)');
    const { log } = renderOnce(makeGame({ phase: 'ended', phaseTicks: 17, blue: 3, winner: Team.blue }));
    expect(log).toMatchSnapshot();
  });

  it('overtime, hidden while the room menu is open', () => {
    const game = makeGame({ phase: 'playing', overtime: true, tick: 600, time: 182 });
    const { log } = renderOnce(game);
    expect(texts(log)).toContain('main.fillText("OVERTIME!", 400, 58)');
    expect(log).toContain(`main.fillStyle = "${defaultTheme.hud.overtime}"`);
    expect(log).toMatchSnapshot();
    expect(texts(renderOnce(game, { menuOpen: true }).log)).not.toContain('main.fillText("OVERTIME!", 400, 58)');
  });

  it('warns on the clock in the last 30 seconds of the time limit', () => {
    const warn = `main.fillStyle = "${defaultTheme.hud.clockWarn}"`;
    expect(renderOnce(makeGame({ phase: 'playing', time: 149 })).log).not.toContain(warn);
    expect(renderOnce(makeGame({ phase: 'playing', time: 150 })).log).toContain(warn);
    expect(renderOnce(makeGame({ phase: 'playing', time: 170, timeLimit: 0 })).log).not.toContain(warn);
  });

  it('paused and unpause countdown', () => {
    const paused = renderOnce(makeGame({ phase: 'playing', pauseCounter: 120 })).log;
    expect(texts(paused)).toContain('main.fillText("Game Paused", 400, 225)');
    expect(paused).toMatchSnapshot();
    expect(texts(renderOnce(makeGame({ phase: 'playing', pauseCounter: 70 })).log)).toContain('main.fillText("2", 400, 225)');
  });

  it('draws an arrow toward an off-screen local player', () => {
    const base = makeGame();
    const game = makeGame({ players: [player(1, Team.red, { x: -2000, y: 0 }), base.players[1]!] });
    const { log } = renderOnce(game, { view: { ...defaultView, clampCamera: true } });
    expect(log).toContain(`main.fillStyle = "${defaultTheme.local.arrow}"`);
    expect(renderOnce(makeGame()).log).not.toContain(`main.fillStyle = "${defaultTheme.local.arrow}"`);
  });

  it('draws arrows in the team color toward other off-screen players', () => {
    const base = makeGame();
    const game = makeGame({ players: [base.players[0]!, player(2, Team.blue, { x: 2000, y: 0 })] });
    const { log } = renderOnce(game);
    const arrowAt = log.lastIndexOf(`main.strokeStyle = "${defaultTheme.local.arrowOutline}"`);
    expect(arrowAt).toBeGreaterThan(0);
    expect(log[arrowAt - 1]).toBe('main.fillStyle = "#0055cc"');
    expect(log).not.toContain(`main.fillStyle = "${defaultTheme.local.arrow}"`);
  });

  it('draws names, then players, then stadium discs over them with the ball first, as the original does', () => {
    const { log } = renderOnce(makeGame());
    const at = (entry: string) => log.indexOf(entry);
    expect(at('main.strokeText("Bora", 170, 27)')).toBeLessThan(at('main.arc(-170, 0, 15, 0, 6.283)'));
    expect(at('main.arc(-170, 0, 15, 0, 6.283)')).toBeLessThan(at('main.arc(0, 0, 10, 0, 6.283)'));
    expect(at('main.arc(0, 0, 10, 0, 6.283)')).toBeLessThan(at('main.arc(-370, 64, 8, 0, 6.283)'));
  });

  it('keeps the outline of a "transparent" disc and draws a visible "transparent" segment white', () => {
    const game = makeGame();
    game.stadium = { ...game.stadium, segments: [{ ...game.stadium.segments[0]!, color: -1 }] };
    const { log } = renderOnce(game);
    const transparent = log.indexOf('main.arc(0, 300, 5, 0, 6.283)');
    expect(transparent).toBeGreaterThan(-1);
    expect(log.slice(transparent, transparent + 2)).toEqual(['main.arc(0, 300, 5, 0, 6.283)', 'main.stroke()']);
    const segment = log.indexOf('main.moveTo(-370, 170)');
    expect(log.slice(0, segment).reverse().find((l) => l.startsWith('main.strokeStyle'))).toBe('main.strokeStyle = "#ffffff"');
  });

  it('points at the ball when it is off screen, like at players', () => {
    const arrows = (game: GameState) => renderOnce(game).log.filter((l) => l.startsWith('main.rotate(')).length;
    const far = makeGame();
    far.discs[0] = { ...far.discs[0]!, pos: { x: 5000, y: 0 } };
    expect(arrows(far) - arrows(makeGame())).toBe(1);
  });

  it('skips a disc with a negative radius instead of letting arc() throw', () => {
    const game = makeGame();
    game.discs[1] = { ...game.discs[1]!, radius: -4 };
    const { log } = renderOnce(game);
    expect(log).toContain('main.arc(-370, 64, 0, 0, 6.283)');
    expect(log.some((l) => /arc\([^,]+, [^,]+, -/.test(l))).toBe(false);
  });

  it("draws the host's hud items at their screen fractions with their own alignment and color", () => {
    const game = makeGame();
    const room = { ...makeRoom(game), hud: [{ id: 'a', text: 'Round 2', x: 0.25, y: 0.5, align: 'left' as const, color: 0x00ff00, size: 24 }] };
    const { log } = renderOnce(game, { room });
    const at = log.indexOf('main.fillText("Round 2", 200, 225)');
    expect(at).toBeGreaterThan(-1);
    expect(log.slice(0, at).reverse().find((l) => l.startsWith('main.textAlign'))).toBe('main.textAlign = "left"');
    expect(log.slice(0, at).reverse().find((l) => l.startsWith('main.fillStyle'))).toBe('main.fillStyle = "#00ff00"');
  });

  it("follows the host's camera target and multiplies the zoom", () => {
    const game = makeGame();
    const scaleOf = (log: string[]) => log.find((l) => l.startsWith('main.scale('));
    const plain = renderOnce(game).log;
    const zoomed = renderOnce(game, { room: { ...makeRoom(game), camera: { follow: { type: 'point', x: 100, y: 50 }, zoom: 2 } } }).log;
    const [sx] = /main\.scale\(([\d.]+)/.exec(scaleOf(plain)!)!.slice(1).map(Number);
    expect(scaleOf(zoomed)).toBe(`main.scale(${sx! * 2}, ${sx! * 2})`);
    expect(zoomed).toContain('main.translate(-100, -50)');
  });

  it('maps a camera disc index to stadium discs first, then player discs, like getDiscProperties', () => {
    const game = makeGame();
    const pos = { discs: game.discs.map((d) => d.pos), players: new Map([[1, { x: -170, y: 0 }], [2, { x: 170, y: 0 }]]) };
    expect(followed({ type: 'disc', index: 1 }, game, pos)).toEqual({ x: -370, y: 64 });
    expect(followed({ type: 'disc', index: game.discs.length + 1 }, game, pos)).toEqual({ x: 170, y: 0 });
    expect(followed({ type: 'disc', index: 99 }, game, pos)).toBeNull();
    expect(followed({ type: 'player', id: 3 }, game, pos)).toBeNull();
  });

  it('asks for a desynchronized context only with the low latency setting', () => {
    expect(renderOnce(makeGame(), {}, false).log[0]).toBe('main.getContext("2d", {"desynchronized":false,"alpha":false})');
  });

  it('keeps the last valid camera position when the physics produce NaN', () => {
    const fake = createFakeCanvas(800, 450);
    const renderer = createRenderer(fake.element, defaultTheme, true);
    const frame = (game: GameState): RenderFrame => ({ prev: game, curr: game, alpha: 0, room: makeRoom(game), localPlayerId: 1, view: defaultView, typingPlayerIds: new Set(), menuOpen: false });
    const translations = () => fake.log.filter((l) => l.startsWith('main.translate(') && !l.startsWith('main.translate(400'));
    renderer.render(frame(makeGame()));
    const valid = translations()[0];
    const broken = makeGame();
    broken.discs[0] = { ...broken.discs[0]!, pos: { x: Number.NaN, y: Number.NaN } };
    broken.players[0] = player(1, Team.red, { x: Number.NaN, y: 0 });
    fake.log.length = 0;
    renderer.render(frame(broken));
    expect(translations()[0]).toBe(valid);
  });

  it('scales the backing store by devicePixelRatio and resolution scale', () => {
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    const { canvas } = renderOnce(makeGame(), { view: { ...defaultView, resolutionScale: 0.5 } });
    expect([canvas.width, canvas.height]).toEqual([800, 450]);
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    const full = renderOnce(makeGame()).canvas;
    expect([full.width, full.height]).toEqual([1600, 900]);
  });

  it('uses theme team colors when custom colors are off', () => {
    const { log } = renderOnce(makeGame(), { view: { ...defaultView, customTeamColors: false } });
    expect(log).toContain('surface1.fillStyle = "#f0563c"');
    expect(log).not.toContain('surface1.fillStyle = "#cc2200"');
  });
});

describe('kickHighlight', () => {
  const game = makeGame({ phase: 'playing' });
  it('requires a latched kick, no pause and an available kick', () => {
    expect(kickHighlight(player(1, Team.red, { x: 0, y: 0 }, { kicking: true }), game)).toBe(true);
    expect(kickHighlight(player(1, Team.red, { x: 0, y: 0 }, { kicking: false }), game)).toBe(false);
    expect(kickHighlight(player(1, Team.red, { x: 0, y: 0 }, { kicking: true, kickCooldown: 1 }), game)).toBe(false);
    expect(kickHighlight(player(1, Team.red, { x: 0, y: 0 }, { kicking: true, kickTokens: -1 }), game)).toBe(false);
    expect(kickHighlight(player(1, Team.red, { x: 0, y: 0 }, { kicking: true }), { ...game, pauseCounter: 30 })).toBe(false);
  });
});

describe('arcCounterClockwise', () => {
  it('sweeps whichever way spans the curve angle', () => {
    expect(arcCounterClockwise(-Math.PI / 2, Math.PI, 1)).toBe(true);
    expect(arcCounterClockwise(Math.PI, -Math.PI / 2, 1)).toBe(false);
    expect(arcCounterClockwise(0, Math.PI, 0)).toBe(false);
  });

  it('centres the camera on the area above the chat', () => {
    const cameraY = (bottomInset: number) => {
      const { log } = renderOnce(makeGame(), { view: { ...defaultView, clampCamera: false, bottomInset } });
      const moves = log.filter((l) => l.startsWith('main.translate('));
      return Number(/, (-?[\d.]+)\)$/.exec(moves[1]!)![1]);
    };
    expect(cameraY(0) - cameraY(100)).toBeCloseTo(50);
  });
});
