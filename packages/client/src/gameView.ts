import type { GameState, TickOutcome } from '@golix/shared';
import type { SoundName } from './audio/recipes.ts';
import type { NetSession } from './net/netSession.ts';
import { createRenderer, type Renderer } from './render/index.ts';
import type { SettingsStore } from './settings/settings.ts';
import type { Theme } from './theme/index.ts';

export interface GameViewDeps {
  session: NetSession;
  /** Receives the canvas; it is removed again when the session closes. */
  layer: HTMLElement;
  settings: SettingsStore;
  theme: Theme;
  menuOpen(): boolean;
  playSound(name: SoundName): void;
  stopSounds(): void;
}

const OUTCOME_SOUNDS: Partial<Record<TickOutcome['type'], SoundName>> = { kick: 'kick', goal: 'goal' };
const FRAME_SLACK_MS = 1;
const PING_SAMPLES = 5;
const STATS_INTERVAL_MS = 1000;
const GRAPH_WIDTH = 90;
const GRAPH_HEIGHT = 40;
const BAR_WIDTH = 3;
export const GRAPH_BARS = GRAPH_WIDTH / BAR_WIDTH;
/** The room reports pings every 2 seconds. */
const PING_EVENT_MS = 2000;
/** Ping at the top of the graph until a higher one raises it. */
const GRAPH_MIN_SCALE_MS = 200;

/**
 * Adds a ping sample `gapMs` after the previous one; every report that should have come in between
 * is a stall, kept as null and drawn as a red bar.
 */
export function recordPing(history: (number | null)[], ms: number, gapMs: number): void {
  const missed = Math.min(Math.round(gapMs / PING_EVENT_MS) - 1, GRAPH_BARS);
  for (let i = 0; i < missed; i++) history.push(null);
  history.push(ms);
  history.splice(0, history.length - GRAPH_BARS);
}

/** One bar per ping report, newest on the right, scaled to the highest ping shown. */
function drawPingGraph(canvas: HTMLCanvasElement, history: readonly (number | null)[]): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.clearRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT);
  const scale = Math.max(GRAPH_MIN_SCALE_MS, ...history.map((ms) => ms ?? 0));
  const x0 = GRAPH_WIDTH - history.length * BAR_WIDTH;
  history.forEach((ms, i) => {
    const height = ms === null ? GRAPH_HEIGHT : Math.max(1, Math.round((ms / scale) * GRAPH_HEIGHT));
    ctx.fillStyle = ms === null ? '#ef4444' : '#4ade80';
    ctx.fillRect(x0 + i * BAR_WIDTH, GRAPH_HEIGHT - height, BAR_WIDTH - 1, height);
  });
}

/**
 * Positions come from the predicted state, but score, clock and banners only from the server-confirmed one:
 * a late save must not flash a goal the prediction thought it saw.
 */
export function withConfirmedScore(predicted: GameState, confirmed: GameState): GameState {
  const { phase, phaseTicks, scoringTeam, winner, red, blue, time, overtime, pauseCounter, timeLimit, scoreLimit } = confirmed;
  return { ...predicted, phase, phaseTicks, scoringTeam, winner, red, blue, time, overtime, pauseCounter, timeLimit, scoreLimit };
}

/**
 * The frames to draw. While the confirmed game is paused or counting down, it is drawn as is: the prediction
 * runs ahead of it and would show play resuming before the countdown ends.
 */
export function drawnGames(prev: GameState | null, curr: GameState, confirmed: GameState | null): { prev: GameState; curr: GameState } {
  if (confirmed !== null && confirmed.pauseCounter > 0) return { prev: confirmed, curr: confirmed };
  return { prev: prev ?? curr, curr: confirmed === null ? curr : withConfirmedScore(curr, confirmed) };
}

/** "Ping: min - max" over the last few host measurements and "Fps: n" over the last second. */
export function statsText(pings: readonly number[], fps: number): string {
  const ping = pings.length === 0 ? '-' : `${Math.min(...pings)} - ${Math.max(...pings)}`;
  return `Ping: ${ping}\nFps: ${fps}`;
}

/** Draws the predicted match every animation frame and plays the sounds of confirmed ticks. */
export function mountGameView({ session, layer, settings, theme, menuOpen, playSound, stopSounds }: GameViewDeps): void {
  let canvas: HTMLCanvasElement;
  let renderer: Renderer;
  const mountCanvas = () => {
    const next = layer.ownerDocument.createElement('canvas');
    next.className = 'dk-game-canvas';
    if (canvas === undefined) layer.append(next);
    else canvas.replaceWith(next);
    canvas = next;
    renderer = createRenderer(canvas, theme, settings.get('lowLatencyCanvas'));
  };
  mountCanvas();
  const offSettings = settings.subscribe((key) => key === 'lowLatencyCanvas' && mountCanvas());
  const typing = new Set<number>();
  const doc = layer.ownerDocument;
  const stats = doc.createElement('div');
  stats.className = 'dk-stats';
  const statsLines = doc.createElement('div');
  const graph = doc.createElement('canvas');
  graph.width = GRAPH_WIDTH;
  graph.height = GRAPH_HEIGHT;
  stats.append(statsLines, graph);
  layer.append(stats);
  const pings: number[] = [];
  const pingHistory: (number | null)[] = [];
  let pingAt: number | null = null;

  const offEvents = session.onEvent((ev) => {
    if (ev.type === 'ping') {
      const own = ev.pings.find(([id]) => id === session.playerId);
      if (own !== undefined) {
        const now = performance.now();
        pings.push(own[1]);
        if (pings.length > PING_SAMPLES) pings.shift();
        recordPing(pingHistory, own[1], pingAt === null ? 0 : now - pingAt);
        pingAt = now;
        drawPingGraph(graph, pingHistory);
      }
    }
    if (ev.type === 'setTyping' && ev.typing) typing.add(ev.playerId);
    else if (ev.type === 'setTyping' || ev.type === 'playerLeave') typing.delete(ev.playerId);
  });

  const offTicks = session.onTick((_tick, outcomes) => {
    for (const o of outcomes) {
      if (o.type === 'gameStop') stopSounds();
      const sound = OUTCOME_SOUNDS[o.type];
      if (sound !== undefined) playSound(sound);
    }
  });

  let last = -Infinity;
  let frames = 0;
  let statsAt = -Infinity;
  let frame = requestAnimationFrame(function draw(now: number) {
    frame = requestAnimationFrame(draw);
    const fps = settings.get('fpsLimit');
    if (fps > 0 && now - last < 1000 / fps - FRAME_SLACK_MS) return;
    last = now;
    canvas.hidden = session.getRoom().game === null;
    stats.hidden = canvas.hidden;
    if (canvas.hidden) return;
    frames++;
    if (now - statsAt >= STATS_INTERVAL_MS) {
      statsLines.textContent = statsText(pings, statsAt === -Infinity ? 0 : Math.round((frames * 1000) / (now - statsAt)));
      stats.title = `Connection: ${session.path}`;
      // The host has no ping to itself; the original hides the graph there too.
      graph.hidden = session.path === 'host';
      statsAt = now;
      frames = 0;
    }
    const { prev, curr, alpha } = session.getRenderStates(now);
    if (curr.game === null) return;
    renderer.render({
      ...drawnGames(prev.game, curr.game, session.getRoom().game),
      alpha,
      room: curr,
      localPlayerId: session.playerId,
      typingPlayerIds: typing,
      menuOpen: menuOpen(),
      view: {
        viewMode: settings.get('viewMode'),
        resolutionScale: settings.get('resolutionScale'),
        showNames: true,
        showAvatars: settings.get('avatarsEnabled'),
        customTeamColors: settings.get('teamColorsEnabled'),
        showTypingIndicators: settings.get('chatIndicatorsEnabled'),
        clampCamera: true,
        bottomInset: parseFloat(getComputedStyle(layer).getPropertyValue('--dk-chat-space')) || 0,
      },
    });
  });

  session.onClose(() => {
    cancelAnimationFrame(frame);
    stopSounds();
    offEvents();
    offTicks();
    offSettings();
    canvas.remove();
    stats.remove();
  });
}
