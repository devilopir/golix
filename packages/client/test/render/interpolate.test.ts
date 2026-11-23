import { Team } from '@golix/shared';
import { describe, expect, it } from 'vitest';
import { interpolate } from '../../src/render/interpolate.ts';
import { disc, makeGame, player } from './fixtures.ts';

describe('interpolate', () => {
  it('blends disc and player positions by alpha', () => {
    const prev = makeGame();
    const curr = { ...prev, discs: prev.discs.map((d) => ({ ...d, pos: { x: d.pos.x + 10, y: d.pos.y - 4 } })), players: [player(1, Team.red, { x: -160, y: 20 })] };
    const out = interpolate(prev, curr, 0.25);
    expect(out.discs[0]).toEqual({ x: 2.5, y: -1 });
    expect(out.players.get(1)).toEqual({ x: -167.5, y: 5 });
    expect(out.players.has(2)).toBe(false);
  });

  it('uses the current position for players that just got a disc', () => {
    const prev = makeGame();
    const curr = { ...prev, players: [...prev.players.slice(0, 2), player(3, Team.blue, { x: 50, y: 60 })] };
    expect(interpolate(prev, curr, 0.5).players.get(3)).toEqual({ x: 50, y: 60 });
  });

  it('does not blend across a stadium or disc-count change', () => {
    const prev = makeGame();
    const curr = makeGame({ discs: [disc({ x: 40, y: 0 }, 10, 0xffffff)] });
    expect(interpolate(prev, curr, 0.5).discs).toEqual([{ x: 40, y: 0 }]);
  });
});
