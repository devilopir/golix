import { describe, expect, it } from 'vitest';
import { cameraTarget, clampToStadium, resolveView, smoothCamera } from '../../src/render/camera.ts';

describe('resolveView', () => {
  const screen = { width: 1280, height: 720 };

  it('maps fixed modes 1 to 7 to 1x to 2.5x in 0.25 steps', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((m) => resolveView(m, screen, 0).zoom)).toEqual([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5]);
    expect(resolveView(4, screen, 0)).toEqual({ width: 1280, height: 720, zoom: 1.75 });
  });

  it('restricted mode clips the view to 840x410 at 1x', () => {
    expect(resolveView(0, screen, 0)).toEqual({ width: 840, height: 410, zoom: 1 });
    expect(resolveView(0, { width: 600, height: 300 }, 0)).toEqual({ width: 600, height: 300, zoom: 1 });
  });

  it('dynamic mode zooms with window height', () => {
    expect(resolveView(-1, screen, 0).zoom).toBe(1.5);
    expect(resolveView(-1, { width: 1280, height: 360 }, 0).zoom).toBe(0.75);
  });

  it('maxViewWidth zooms in until no more than that width is visible', () => {
    expect(resolveView(1, screen, 400).zoom).toBe(3.2);
    expect(resolveView(7, screen, 1000).zoom).toBe(2.5);
  });
});

describe('cameraTarget', () => {
  const view = { width: 400, height: 300 };

  it('follows the midpoint of ball and player', () => {
    expect(cameraTarget('ball', { x: 100, y: 40 }, { x: 0, y: 0 }, view)).toEqual({ x: 50, y: 20 });
  });

  it('keeps the player at least 50 units inside the view', () => {
    expect(cameraTarget('ball', { x: 1000, y: -1000 }, { x: 0, y: 0 }, view)).toEqual({ x: 150, y: -100 });
  });

  it('player mode ignores the ball', () => {
    expect(cameraTarget('player', { x: 1000, y: 0 }, { x: 7, y: 8 }, view)).toEqual({ x: 7, y: 8 });
  });

  it('falls back to the ball without a local player, and to null without either', () => {
    expect(cameraTarget('ball', { x: 3, y: 4 }, null, view)).toEqual({ x: 3, y: 4 });
    expect(cameraTarget('ball', null, null, view)).toBeNull();
  });
});

describe('clampToStadium', () => {
  const stadium = { width: 420, height: 200 };

  it('centers an axis the view already covers', () => {
    expect(clampToStadium({ x: 300, y: -90 }, stadium, { width: 840, height: 500 })).toEqual({ x: 0, y: 0 });
  });

  it('stops the view edge at the stadium bounds', () => {
    expect(clampToStadium({ x: 300, y: -90 }, stadium, { width: 400, height: 300 })).toEqual({ x: 220, y: -50 });
    expect(clampToStadium({ x: 10, y: 5 }, stadium, { width: 400, height: 300 })).toEqual({ x: 10, y: 5 });
  });
});

describe('smoothCamera', () => {
  it('moves 4% of the way per 60 Hz frame, scaled down for shorter frames, capped for longer ones', () => {
    expect(smoothCamera({ x: 0, y: 0 }, { x: 100, y: -50 }, 1 / 60)).toEqual({ x: 4, y: -2 });
    expect(smoothCamera({ x: 0, y: 0 }, { x: 100, y: 0 }, 1 / 120).x).toBeCloseTo(2);
    expect(smoothCamera({ x: 0, y: 0 }, { x: 100, y: 0 }, 1).x).toBe(4);
  });
});

