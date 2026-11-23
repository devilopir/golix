import { Team, type CameraFollow, type Disc, type GameState, type PlayingTeam, type RoomPlayer, type RoomState, type SimPlayer, type Stadium, type TeamColors, type Vec2 } from '@golix/shared';
import type { Theme } from '../theme/index.ts';
import { drawBackground, type WorldRect } from './background.ts';
import { cameraTarget, clampToStadium, resolveView, smoothCamera, type Size, type View } from './camera.ts';
import { css } from './color.ts';
import { drawHud, drawHudItems, outlinedText } from './hud.ts';
import { interpolate, type Positions } from './interpolate.ts';
import { createPatternCache, PATTERN_SIZE, stripeAngle } from './teamPattern.ts';
import type { RenderFrame } from './types.ts';

export interface Renderer {
  render(frame: RenderFrame): void;
  resize(): void;
}

export function kickHighlight(player: SimPlayer, game: GameState): boolean {
  return player.kicking && game.pauseCounter === 0 && player.kickCooldown <= 0 && player.kickTokens >= 0;
}

/** `lowLatency` asks for a desynchronized context; a canvas keeps its first context, so changing it needs a new canvas. */
export function createRenderer(canvas: HTMLCanvasElement, theme: Theme, lowLatency: boolean): Renderer {
  const ctx = canvas.getContext('2d', { desynchronized: lowLatency, alpha: false });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const teamPattern = createPatternCache(ctx, () => canvas.ownerDocument.createElement('canvas'));
  let resolutionScale = 1;
  let pixelRatio = 1;
  let camera: Vec2 | null = null;
  let cameraStadium: Stadium | null = null;
  let lastTime: number | null = null;

  const resize = (): void => {
    pixelRatio = (globalThis.devicePixelRatio || 1) * resolutionScale;
    const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  };

  const updateCamera = (frame: RenderFrame, pos: Positions, localPos: Vec2 | null, world: Size): Vec2 => {
    const stadium = frame.curr.stadium;
    let target = followed(frame.room.camera.follow, frame.curr, pos) ?? cameraTarget(stadium.cameraFollow, pos.discs[0] ?? null, localPos, world) ?? camera ?? { x: 0, y: 0 };
    if (frame.view.clampCamera) target = clampToStadium(target, stadium, world);
    const now = performance.now();
    const next = camera && cameraStadium === stadium && lastTime !== null ? smoothCamera(camera, target, (now - lastTime) / 1000) : target;
    if (Number.isFinite(next.x) && Number.isFinite(next.y)) {
      camera = next;
      cameraStadium = stadium;
    }
    lastTime = now;
    return camera ?? { x: 0, y: 0 };
  };

  const render = (frame: RenderFrame): void => {
    resolutionScale = frame.view.resolutionScale;
    resize();
    const { curr, room } = frame;
    const screen = { width: canvas.clientWidth, height: canvas.clientHeight };
    const base = resolveView(frame.view.viewMode, screen, curr.stadium.maxViewWidth);
    const view = { ...base, zoom: base.zoom * room.camera.zoom };
    const offsetX = (screen.width - view.width) / 2;
    const offsetY = (screen.height - view.height) / 2;
    const pos = interpolate(frame.prev, curr, frame.alpha);
    const localPos = frame.localPlayerId === null ? null : (pos.players.get(frame.localPlayerId) ?? null);
    const world = { width: view.width / view.zoom, height: view.height / view.zoom };
    // Like the original, the camera follows and clamps within the area above the chat, which still draws underneath it.
    const inset = Math.min(frame.view.bottomInset, view.height / 2) / view.zoom;
    const followed = updateCamera(frame, pos, localPos, { width: world.width, height: world.height - inset });
    const cam = { x: followed.x, y: followed.y + inset / 2 };
    const pick = (custom: TeamColors, fallback: TeamColors) => (frame.view.customTeamColors && custom.colors.length > 0 ? custom : fallback);
    const colors: Record<PlayingTeam, TeamColors> = { [Team.red]: pick(room.redColors, theme.teams.red), [Team.blue]: pick(room.blueColors, theme.teams.blue) };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.letterbox;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, offsetX * pixelRatio, offsetY * pixelRatio);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, view.width, view.height);
    ctx.clip();
    ctx.translate(view.width / 2, view.height / 2);
    ctx.scale(view.zoom, view.zoom);
    ctx.translate(-cam.x, -cam.y);
    const visible: WorldRect = { x: cam.x - world.width / 2, y: cam.y - world.height / 2, ...world };
    drawWorld(ctx, theme, frame, pos, colors, teamPattern, visible);
    ctx.restore();

    const fill = { [Team.red]: css(colors[Team.red].colors[0]!), [Team.blue]: css(colors[Team.blue].colors[0]!) };
    const ball = pos.discs[0];
    if (ball !== undefined && curr.discs[0] !== undefined) drawOffscreenArrow(ctx, theme, ball, cam, view, css(curr.discs[0].color));
    for (const p of curr.players) {
      const at = pos.players.get(p.id);
      if (p.team === Team.spectators || at === undefined) continue;
      drawOffscreenArrow(ctx, theme, at, cam, view, p.id === frame.localPlayerId ? theme.local.arrow : fill[p.team]);
    }
    drawHud(ctx, theme, room, curr, fill, view, frame.alpha, frame.menuOpen);
    drawHudItems(ctx, theme, room.hud, view);
  };

  return { render, resize };
}

function drawWorld(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  frame: RenderFrame,
  pos: Positions,
  colors: Record<PlayingTeam, TeamColors>,
  teamPattern: (colors: TeamColors) => CanvasPattern,
  visible: WorldRect,
): void {
  const { curr, room } = frame;
  const stadium = curr.stadium;
  const roomPlayers = new Map(room.players.map((p) => [p.id, p]));
  drawBackground(ctx, theme, stadium.bg, visible);

  ctx.lineWidth = theme.segment.width;
  // A visible "transparent" segment is drawn white, as in the original.
  for (const seg of stadium.segments) {
    if (!seg.vis) continue;
    ctx.strokeStyle = css(seg.color);
    ctx.beginPath();
    const a = stadium.vertexes[seg.v0]!.pos;
    const b = stadium.vertexes[seg.v1]!.pos;
    if (seg.arc) {
      const { center, radius } = seg.arc;
      const a0 = Math.atan2(a.y - center.y, a.x - center.x);
      const a1 = Math.atan2(b.y - center.y, b.x - center.x);
      ctx.arc(center.x, center.y, radius, a0, a1, arcCounterClockwise(a0, a1, seg.curveF));
    } else {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  ctx.lineWidth = theme.joint.width;
  for (const joint of curr.joints) {
    const a = 'disc' in joint.a ? pos.discs[joint.a.disc] : pos.players.get(joint.a.player);
    const b = 'disc' in joint.b ? pos.discs[joint.b.disc] : pos.players.get(joint.b.player);
    if (joint.color === -1 || !a || !b) continue;
    ctx.strokeStyle = css(joint.color);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  const onField = curr.players.filter((p): p is SimPlayer & { team: PlayingTeam } => p.disc !== null && p.team !== Team.spectators);
  if (frame.view.showNames) {
    for (const p of onField) {
      const name = roomPlayers.get(p.id)?.name;
      if (!name || p.id === frame.localPlayerId) continue;
      const at = pos.players.get(p.id)!;
      outlinedText(ctx, theme.player.name, theme.player.nameSize, name, theme.player.name.color, at.x, at.y + p.disc!.radius + theme.player.nameGap);
    }
  }

  for (const p of onField) {
    const at = pos.players.get(p.id)!;
    const r = radiusOf(p.disc!);
    if (p.id === frame.localPlayerId) {
      ctx.strokeStyle = theme.local.ring;
      ctx.lineWidth = theme.local.ringWidth;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + theme.local.ringGap, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (frame.view.showTypingIndicators && frame.typingPlayerIds.has(p.id)) drawTyping(ctx, theme, at.x, at.y - r - 8);
  }

  for (const p of onField) {
    const at = pos.players.get(p.id)!;
    const r = radiusOf(p.disc!);
    const own = roomPlayers.get(p.id)?.colors;
    const teamColors = frame.view.customTeamColors && own !== undefined && own.colors.length > 0 ? own : colors[p.team];
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(stripeAngle(teamColors.angle));
    ctx.scale((2 * r) / PATTERN_SIZE, (2 * r) / PATTERN_SIZE);
    ctx.translate(-PATTERN_SIZE / 2, -PATTERN_SIZE / 2);
    ctx.fillStyle = teamPattern(teamColors);
    ctx.beginPath();
    ctx.arc(PATTERN_SIZE / 2, PATTERN_SIZE / 2, PATTERN_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = kickHighlight(p, curr) ? theme.player.kickOutline : theme.player.outline;
    ctx.lineWidth = theme.player.outlineWidth;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.stroke();

    const label = avatarText(room, roomPlayers.get(p.id), p, frame.view.showAvatars);
    if (label) {
      ctx.fillStyle = css(teamColors.textColor);
      ctx.font = `${theme.player.avatarWeight} ${r * theme.player.avatarScale}px ${theme.player.avatarFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      // Centre the inked glyphs rather than the font box, and shrink wide or tall avatars to fit the disc.
      const m = ctx.measureText(label);
      const extent = Math.max(m.actualBoundingBoxLeft + m.actualBoundingBoxRight, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
      const fit = Math.min(1, (r * theme.player.avatarMaxExtent) / Math.max(extent, 1));
      ctx.save();
      ctx.translate(at.x, at.y);
      ctx.scale(fit, fit);
      ctx.fillText(label, (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2, (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
      ctx.restore();
    }
  }

  // As in the original, stadium discs and the ball go over the players; a "transparent" one keeps its outline.
  curr.discs.forEach((disc, i) => {
    const outline = i === 0 ? theme.ball : theme.disc;
    drawDisc(ctx, pos.discs[i]!, radiusOf(disc), disc.color === -1 ? null : css(disc.color), outline.outline, outline.outlineWidth);
  });
}

/** Picks the canvas sweep direction whose span matches the curve angle encoded by curveF = cot(curve / 2). */
export function arcCounterClockwise(a0: number, a1: number, curveF: number): boolean {
  const half = Math.atan(1 / curveF);
  const curve = 2 * (half < 0 ? half + Math.PI : half);
  const tau = Math.PI * 2;
  const clockwise = (((a1 - a0) % tau) + tau) % tau;
  return Math.abs(clockwise - curve) > Math.abs(tau - clockwise - curve);
}

function avatarText(room: RoomState, rp: RoomPlayer | undefined, player: SimPlayer, showAvatars: boolean): string {
  if (showAvatars && rp?.avatar) return rp.avatar;
  const index = room.players.filter((p) => p.team === player.team).findIndex((p) => p.id === player.id);
  return index < 0 ? '' : String(index + 1);
}

/** Where the host's camera points; disc indexes count stadium discs, then player discs, as getDiscProperties does. Null when gone. */
export function followed(follow: CameraFollow | null, game: GameState, pos: Positions): Vec2 | null {
  if (follow === null) return null;
  if (follow.type === 'point') return { x: follow.x, y: follow.y };
  if (follow.type === 'player') return pos.players.get(follow.id) ?? null;
  if (follow.index < game.discs.length) return pos.discs[follow.index] ?? null;
  const owner = game.players.filter((p) => p.disc !== null)[follow.index - game.discs.length];
  return owner === undefined ? null : (pos.players.get(owner.id) ?? null);
}

/** Canvas arc() throws on a negative radius, which a script or map can set; the disc is then not drawn. */
function radiusOf(disc: Disc): number {
  return Math.max(0, disc.radius);
}

/** `fill` null draws the outline only. */
function drawDisc(ctx: CanvasRenderingContext2D, at: Vec2, radius: number, fill: string | null, outline: string, width: number): void {
  ctx.strokeStyle = outline;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  if (fill !== null) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.stroke();
}

function drawTyping(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number): void {
  ctx.fillStyle = theme.typing.bubble;
  ctx.beginPath();
  ctx.roundRect(x - 9, y - 9, 18, 9, 4.5);
  ctx.fill();
  ctx.fillStyle = theme.typing.dot;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.arc(x + i * 4.5, y - 4.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawOffscreenArrow(ctx: CanvasRenderingContext2D, theme: Theme, player: Vec2, cam: Vec2, view: View, color: string): void {
  const sx = (player.x - cam.x) * view.zoom;
  const sy = (player.y - cam.y) * view.zoom;
  const halfW = view.width / 2;
  const halfH = view.height / 2;
  if (Math.abs(sx) <= halfW && Math.abs(sy) <= halfH) return;
  const m = theme.local.arrowMargin;
  const k = Math.min((halfW - m) / Math.abs(sx), (halfH - m) / Math.abs(sy));
  const s = theme.local.arrowSize;
  ctx.save();
  ctx.translate(halfW + sx * k, halfH + sy * k);
  ctx.rotate(Math.atan2(sy, sx));
  ctx.beginPath();
  ctx.moveTo(s, 0);
  ctx.lineTo(-s * 0.6, s * 0.7);
  ctx.lineTo(-s * 0.6, -s * 0.7);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = theme.local.arrowOutline;
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
