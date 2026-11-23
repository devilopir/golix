import type { Vec2 } from '@golix/shared';

export const RESTRICTED_VIEW = { width: 840, height: 410 } as const;
/** World units visible vertically in dynamic mode; the original factor is undocumented. */
export const DYNAMIC_VIEW_HEIGHT = 480;
export const PLAYER_EDGE_MARGIN = 50;
export const CAMERA_SMOOTHING = 0.04;

export interface Size {
  width: number;
  height: number;
}

export interface View {
  /** Screen area the world is drawn into, in CSS pixels. */
  width: number;
  height: number;
  /** CSS pixels per world unit. */
  zoom: number;
}

export function resolveView(mode: number, screen: Size, maxViewWidth: number): View {
  let width = screen.width;
  let height = screen.height;
  let zoom: number;
  if (mode === 0) {
    width = Math.min(width, RESTRICTED_VIEW.width);
    height = Math.min(height, RESTRICTED_VIEW.height);
    zoom = 1;
  } else if (mode < 0) {
    zoom = height / DYNAMIC_VIEW_HEIGHT;
  } else {
    zoom = 1 + (Math.min(mode, 7) - 1) * 0.25;
  }
  if (maxViewWidth > 0 && width / zoom > maxViewWidth) zoom = width / maxViewWidth;
  return { width, height, zoom };
}

export function cameraTarget(
  follow: 'ball' | 'player',
  ball: Vec2 | null,
  player: Vec2 | null,
  viewWorld: Size,
): Vec2 | null {
  if (!player) return ball ? { x: ball.x, y: ball.y } : null;
  if (follow === 'player' || !ball) return { x: player.x, y: player.y };
  const mx = Math.max(0, viewWorld.width / 2 - PLAYER_EDGE_MARGIN);
  const my = Math.max(0, viewWorld.height / 2 - PLAYER_EDGE_MARGIN);
  return {
    x: clamp((ball.x + player.x) / 2, player.x - mx, player.x + mx),
    y: clamp((ball.y + player.y) / 2, player.y - my, player.y + my),
  };
}

/** Keeps the view inside the stadium's width × height rectangle; centers an axis the view already covers. */
export function clampToStadium(p: Vec2, stadium: Size, viewWorld: Size): Vec2 {
  return {
    x: clampAxis(p.x, stadium.width, viewWorld.width),
    y: clampAxis(p.y, stadium.height, viewWorld.height),
  };
}

export function smoothCamera(origin: Vec2, target: Vec2, dt: number): Vec2 {
  const k = CAMERA_SMOOTHING * Math.min(1, 60 * dt);
  return { x: origin.x + (target.x - origin.x) * k, y: origin.y + (target.y - origin.y) * k };
}

function clampAxis(v: number, half: number, view: number): number {
  const room = half - view / 2;
  return room <= 0 ? 0 : clamp(v, -room, room);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
