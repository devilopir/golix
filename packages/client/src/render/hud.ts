import { Team, type GameState, type HudItem, type PlayingTeam, type RoomState } from '@golix/shared';
import { css } from './color.ts';
import type { TextStyle, Theme } from '../theme/index.ts';
import type { Size } from './camera.ts';

const TEAM_NAMES: Record<PlayingTeam, string> = { [Team.red]: 'Red', [Team.blue]: 'Blue' };

/** The host's name for a team, or "Red" and "Blue". */
export function teamName(room: Pick<RoomState, 'redName' | 'blueName'>, team: PlayingTeam): string {
  const name = team === Team.red ? room.redName : room.blueName;
  return name !== '' ? name : TEAM_NAMES[team];
}
export const PAUSED_COUNTER = 120;
const BANNER_IN_TICKS = 15;
/** The victory text shows from 0.2 s to 2.5 s into the ended phase, then the field stays empty. */
const VICTORY_FROM_TICKS = 12;
const VICTORY_UNTIL_TICKS = 150;
const CLOCK_WARN_SECONDS = 30;

export function formatClock(time: number): string {
  const seconds = Math.floor(time);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  room: RoomState,
  game: GameState,
  teamFill: Record<PlayingTeam, string>,
  view: Size,
  alpha: number,
  menuOpen: boolean,
): void {
  drawScoreboard(ctx, theme, game, teamFill, view, menuOpen);
  if (game.phase === 'goal' && game.scoringTeam !== null) {
    drawBanner(ctx, theme, `${teamName(room, game.scoringTeam)} Scores!`, teamFill[game.scoringTeam], view, game.phaseTicks + alpha);
  } else if (game.phase === 'ended' && game.winner !== null && game.phaseTicks >= VICTORY_FROM_TICKS && game.phaseTicks < VICTORY_UNTIL_TICKS) {
    drawBanner(ctx, theme, `${teamName(room, game.winner)} is Victorious!`, teamFill[game.winner], view, game.phaseTicks - VICTORY_FROM_TICKS + alpha);
  }
  if (game.pauseCounter > 0) drawPause(ctx, theme, game.pauseCounter, view);
}

/** The host's own text, placed by fractions of the view. */
export function drawHudItems(ctx: CanvasRenderingContext2D, theme: Theme, items: readonly HudItem[], view: Size): void {
  for (const item of items) outlinedText(ctx, theme.hud.banner, item.size, item.text, css(item.color), item.x * view.width, item.y * view.height, item.align);
}

function drawScoreboard(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  game: GameState,
  teamFill: Record<PlayingTeam, string>,
  view: Size,
  menuOpen: boolean,
): void {
  const hud = theme.hud;
  const cx = view.width / 2;
  const top = 10;
  const height = 38;
  const mid = top + height / 2;
  ctx.fillStyle = hud.panel;
  ctx.beginPath();
  ctx.roundRect(cx - 104, top, 208, height, hud.panelRadius);
  ctx.fill();

  ctx.textBaseline = 'middle';
  for (const [team, side] of [[Team.red, -1], [Team.blue, 1]] as const) {
    ctx.fillStyle = teamFill[team];
    ctx.beginPath();
    ctx.roundRect(cx + side * 88 - 6, mid - 9, 12, 18, 3);
    ctx.fill();
    ctx.fillStyle = hud.score;
    ctx.font = `800 ${hud.scoreSize}px ${hud.family}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(team === Team.red ? game.red : game.blue), cx + side * 60, mid + 1);
  }

  const blinkOn = Math.floor(game.tick / 30) % 2 === 0;
  ctx.font = `700 ${hud.clockSize}px ${hud.family}`;
  const warn = !game.overtime && game.timeLimit > 0 && game.timeLimit * 60 - game.time <= CLOCK_WARN_SECONDS;
  ctx.fillStyle = game.overtime ? hud.overtime : warn ? hud.clockWarn : hud.clock;
  ctx.fillText(formatClock(game.time), cx, mid + 1);
  if (game.overtime && blinkOn && !menuOpen) {
    ctx.font = `800 11px ${hud.family}`;
    ctx.fillText('OVERTIME!', cx, top + height + 10);
  }
}

function drawBanner(ctx: CanvasRenderingContext2D, theme: Theme, text: string, fill: string, view: Size, ticks: number): void {
  const p = Math.min(1, ticks / BANNER_IN_TICKS);
  const scale = 1 + (1 - p) * (1 - p) * 0.6;
  ctx.save();
  ctx.globalAlpha = p;
  ctx.translate(view.width / 2, view.height * 0.4);
  ctx.scale(scale, scale);
  outlinedText(ctx, theme.hud.banner, theme.hud.bannerSize, text, fill, 0, 0);
  ctx.restore();
}

function drawPause(ctx: CanvasRenderingContext2D, theme: Theme, counter: number, view: Size): void {
  ctx.fillStyle = theme.hud.overlay;
  ctx.fillRect(0, 0, view.width, view.height);
  const label = counter >= PAUSED_COUNTER ? 'Game Paused' : String(Math.ceil(counter / 60));
  outlinedText(ctx, theme.hud.banner, theme.hud.pausedSize, label, theme.hud.banner.color, view.width / 2, view.height / 2);
}

export function outlinedText(
  ctx: CanvasRenderingContext2D,
  style: TextStyle,
  size: number,
  text: string,
  fill: string,
  x: number,
  y: number,
  align: CanvasTextAlign = 'center',
): void {
  ctx.font = `${style.weight} ${size}px ${style.family}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = style.outlineWidth;
  ctx.strokeStyle = style.outline;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}
