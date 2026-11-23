// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_BARS, drawnGames, mountGameView, recordPing, statsText, withConfirmedScore } from '../src/gameView.ts';
import { makeGame } from './render/fixtures.ts';
import type { NetSession } from '../src/net/netSession.ts';
import { createSettingsStore } from '../src/settings/settings.ts';
import { defaultTheme } from '../src/theme/index.ts';
import { MemoryStorage } from './settings/memoryStorage.ts';

describe('statsText', () => {
  it('shows the ping range of recent samples and the frame rate', () => {
    expect(statsText([28, 56, 31], 121)).toBe('Ping: 28 - 56\nFps: 121');
  });

  it('shows a dash before the first ping sample', () => {
    expect(statsText([], 60)).toBe('Ping: -\nFps: 60');
  });
});

describe('recordPing', () => {
  it('adds one bar per report and a red (null) bar for each report a stall swallowed', () => {
    const history: (number | null)[] = [];
    recordPing(history, 80, 0);
    recordPing(history, 90, 2000);
    recordPing(history, 400, 2900);
    recordPing(history, 120, 6100);
    recordPing(history, 110, 5);
    expect(history).toEqual([80, 90, 400, null, null, 120, 110]);
  });

  it('keeps the newest bars that fit the graph, even after a long stall', () => {
    const history: (number | null)[] = [];
    for (let i = 0; i < GRAPH_BARS + 5; i++) recordPing(history, i, 2000);
    expect(history).toHaveLength(GRAPH_BARS);
    expect(history.at(-1)).toBe(GRAPH_BARS + 4);
    recordPing(history, 50, 10 * 60_000);
    expect(history).toEqual([...Array<null>(GRAPH_BARS - 1).fill(null), 50]);
  });
});

describe('mountGameView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rebuilds the canvas with the low latency setting when it changes', () => {
    const options: unknown[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((_type: string, opts?: unknown) => {
      options.push(opts);
      return {} as CanvasRenderingContext2D;
    });
    let close: (reason: string) => void = () => {};
    const session = {
      playerId: 1,
      getRoom: () => ({ game: null }),
      onEvent: () => () => {},
      onTick: () => () => {},
      onClose: (cb: (reason: string) => void) => {
        close = cb;
        return () => {};
      },
    } as unknown as NetSession;
    const settings = createSettingsStore(new MemoryStorage());
    const layer = document.createElement('div');
    mountGameView({ session, layer, settings, theme: defaultTheme, menuOpen: () => false, playSound: () => {}, stopSounds: () => {} });
    const first = layer.querySelector('.dk-game-canvas');
    settings.set('lowLatencyCanvas', false);
    const canvases = layer.querySelectorAll('.dk-game-canvas');
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).not.toBe(first);
    expect(options).toEqual([
      { desynchronized: true, alpha: false },
      { desynchronized: false, alpha: false },
    ]);
    close('left');
    expect(layer.querySelector('canvas')).toBeNull();
  });
});

describe('withConfirmedScore', () => {
  it('keeps predicted positions but takes score and banners from the confirmed state', () => {
    const predicted = makeGame({ phase: 'goal', phaseTicks: 3, scoringTeam: 1, red: 1 });
    const confirmed = makeGame({ phase: 'playing', phaseTicks: 400, scoringTeam: null, red: 0, time: 12 });
    const drawn = withConfirmedScore(predicted, confirmed);
    expect(drawn).toMatchObject({ phase: 'playing', scoringTeam: null, red: 0, time: 12 });
    expect(drawn.discs).toBe(predicted.discs);
    expect(drawn.players).toBe(predicted.players);
  });
});

describe('drawnGames', () => {
  it('draws the confirmed game while it is paused or counting down, so play does not resume before the countdown ends', () => {
    const predicted = makeGame({ pauseCounter: 0, tick: 105 });
    for (const pauseCounter of [120, 30, 1]) {
      const confirmed = makeGame({ pauseCounter, tick: 100 });
      expect(drawnGames(predicted, predicted, confirmed)).toEqual({ prev: confirmed, curr: confirmed });
    }
    const running = makeGame({ pauseCounter: 0, tick: 100 });
    const drawn = drawnGames(null, predicted, running);
    expect(drawn.prev).toBe(predicted);
    expect(drawn.curr.discs).toBe(predicted.discs);
  });
});
