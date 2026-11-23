import type { Background } from '@golix/shared';
import type { Theme } from '../theme/index.ts';
import { css, shade } from './color.ts';

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function drawBackground(ctx: CanvasRenderingContext2D, theme: Theme, bg: Background, visible: WorldRect): void {
  if (bg.type === 'grass') drawGrass(ctx, theme, bg, visible);
  else if (bg.type === 'hockey') drawHockey(ctx, theme, bg, visible);
  else {
    ctx.fillStyle = css(bg.color);
    ctx.fillRect(visible.x, visible.y, visible.width, visible.height);
  }
}

function drawGrass(ctx: CanvasRenderingContext2D, theme: Theme, bg: Background, visible: WorldRect): void {
  const g = theme.grass;
  ctx.fillStyle = css(shade(bg.color, -g.surroundDarken));
  ctx.fillRect(visible.x, visible.y, visible.width, visible.height);
  ctx.save();
  fieldPath(ctx, bg);
  ctx.clip();
  ctx.fillStyle = css(bg.color);
  ctx.fillRect(-bg.width, -bg.height, bg.width * 2, bg.height * 2);
  ctx.fillStyle = css(shade(bg.color, g.bandLighten));
  fillBands(ctx, bg, g.bandHeight);
  ctx.restore();

  ctx.strokeStyle = theme.lines.color;
  ctx.lineWidth = theme.lines.width;
  fieldPath(ctx, bg);
  ctx.stroke();
  drawCenterMarks(ctx, theme, bg, theme.lines.color);
}

function drawHockey(ctx: CanvasRenderingContext2D, theme: Theme, bg: Background, visible: WorldRect): void {
  const h = theme.hockey;
  ctx.fillStyle = h.surround;
  ctx.fillRect(visible.x, visible.y, visible.width, visible.height);
  ctx.save();
  fieldPath(ctx, bg);
  ctx.clip();
  ctx.fillStyle = h.ice;
  ctx.fillRect(-bg.width, -bg.height, bg.width * 2, bg.height * 2);
  ctx.fillStyle = h.iceBand;
  fillBands(ctx, bg, h.bandHeight);
  ctx.lineWidth = theme.lines.width;
  if (bg.goalLine > 0) {
    verticalLine(ctx, -bg.goalLine, bg.height, h.redLine);
    verticalLine(ctx, bg.goalLine, bg.height, h.blueLine);
  }
  ctx.restore();

  drawCenterMarks(ctx, theme, bg, h.centerLine);
  ctx.strokeStyle = h.boards;
  ctx.lineWidth = h.boardsWidth;
  fieldPath(ctx, bg);
  ctx.stroke();
}

function drawCenterMarks(ctx: CanvasRenderingContext2D, theme: Theme, bg: Background, color: string): void {
  ctx.lineWidth = theme.lines.width;
  verticalLine(ctx, 0, bg.height, color);
  if (bg.kickOffRadius > 0) {
    ctx.beginPath();
    ctx.arc(0, 0, bg.kickOffRadius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, theme.lines.centerSpotRadius, 0, Math.PI * 2);
  ctx.fill();
}

function fillBands(ctx: CanvasRenderingContext2D, bg: Background, band: number): void {
  for (let y = -bg.height + band; y < bg.height; y += band * 2) {
    ctx.fillRect(-bg.width, y, bg.width * 2, Math.min(band, bg.height - y));
  }
}

function verticalLine(ctx: CanvasRenderingContext2D, x: number, halfHeight: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, -halfHeight);
  ctx.lineTo(x, halfHeight);
  ctx.stroke();
}

function fieldPath(ctx: CanvasRenderingContext2D, bg: Background): void {
  ctx.beginPath();
  ctx.roundRect(-bg.width, -bg.height, bg.width * 2, bg.height * 2, Math.max(0, bg.cornerRadius));
}
