import { TICKS_PER_SECOND, applyEvent, cloneRoom, stepRoom, type RoomEvent, type RoomState, type TickOutcome } from '@golix/shared';
import type { Replay, ReplayFrame, ReplayHandicap } from './format.ts';

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 4;
export const KEYFRAME_INTERVAL: number = 10 * TICKS_PER_SECOND;

export type ReplayMark = { frame: number; outcome: Extract<TickOutcome, { type: 'goal' | 'victory' }> };

export interface FrameResult {
  events: readonly RoomEvent[];
  outcomes: TickOutcome[];
}

/** Snapshot frames replace the room; the returned room is then a fresh copy. */
function applyFrame(room: RoomState, frame: ReplayFrame): { room: RoomState; result: FrameResult } {
  if (frame.kind === 'snapshot') return { room: cloneRoom(frame.room), result: { events: [], outcomes: [] } };
  const outcomes: TickOutcome[] = [];
  for (const ev of frame.events) outcomes.push(...applyEvent(room, ev));
  outcomes.push(...stepRoom(room));
  return { room, result: { events: frame.events, outcomes } };
}

/** The part of `replay` from frame `from` up to frame `to`: it starts in the room as it was after `from` frames. */
export function trimReplay(replay: Replay, from: number, to: number): Replay {
  if (!(Number.isInteger(from) && Number.isInteger(to) && 0 <= from && from <= to && to <= replay.frames.length)) {
    throw new RangeError(`frames ${from}-${to} are not within 0-${replay.frames.length}`);
  }
  let start = cloneRoom(replay.start);
  for (let i = 0; i < from; i++) start = applyFrame(start, replay.frames[i]).room;
  const inEffect = new Map<number, ReplayHandicap>();
  const handicaps: ReplayHandicap[] = [];
  for (const h of replay.handicaps) {
    if (h.frame <= from) inEffect.set(h.playerId, { ...h, frame: 0 });
    else if (h.frame <= to) handicaps.push({ ...h, frame: h.frame - from });
  }
  return { start, frames: replay.frames.slice(from, to), handicaps: [...inEffect.values(), ...handicaps] };
}

/** Rebuilds a recorded room frame by frame; frame n is the state after the first n recorded ticks. */
export class ReplayPlayer {
  readonly totalFrames: number;
  /** Goals and victories with the frame they happened in, in order. */
  readonly marks: ReplayMark[] = [];
  private readonly keyframes: RoomState[] = [];
  /** Game clock at every frame; NaN while no game runs. */
  private readonly gameTimes: Float64Array;
  private current: RoomState;
  private before: RoomState;
  private position = 0;
  private carry = 0;
  private rate = 1;
  private running = false;
  private readonly replay: Replay;
  private readonly keyframeInterval: number;

  constructor(replay: Replay, keyframeInterval: number = KEYFRAME_INTERVAL) {
    this.replay = replay;
    this.keyframeInterval = keyframeInterval;
    this.totalFrames = replay.frames.length;
    this.gameTimes = new Float64Array(this.totalFrames + 1);
    let room = cloneRoom(replay.start);
    for (let i = 0; ; i++) {
      if (i % keyframeInterval === 0) this.keyframes.push(cloneRoom(room));
      this.gameTimes[i] = room.game?.time ?? NaN;
      if (i === this.totalFrames) break;
      const next = applyFrame(room, replay.frames[i]);
      room = next.room;
      for (const outcome of next.result.outcomes) if (outcome.type === 'goal' || outcome.type === 'victory') this.marks.push({ frame: i + 1, outcome });
    }
    this.current = cloneRoom(replay.start);
    this.before = this.current;
  }

  get frame(): number {
    return this.position;
  }

  get room(): RoomState {
    return this.current;
  }

  /** State one frame earlier, for interpolation; the same object as `room` right after a seek. */
  get previous(): RoomState {
    return this.before;
  }

  /** Progress from `previous` to `room`, 0 to 1. */
  get alpha(): number {
    return this.running ? this.carry : 1;
  }

  get playing(): boolean {
    return this.running;
  }

  get speed(): number {
    return this.rate;
  }

  set speed(value: number) {
    if (!(value >= MIN_SPEED && value <= MAX_SPEED)) throw new RangeError(`speed must be between ${MIN_SPEED} and ${MAX_SPEED}`);
    this.rate = value;
  }

  /** `playerId`'s recorded handicap at the current frame; 0 when none was recorded. */
  handicap(playerId: number): number {
    let ms = 0;
    for (const h of this.replay.handicaps) if (h.playerId === playerId && h.frame <= this.position) ms = h.ms;
    return ms;
  }

  timeAt(frame: number): number {
    return this.gameTimes[frame];
  }

  /** Starts over from the beginning when already at the end. */
  play(): void {
    if (this.position === this.totalFrames) this.seek(0);
    this.running = this.totalFrames > 0;
  }

  pause(): void {
    this.running = false;
    this.carry = 0;
  }

  /** Applies the next frame; null at the end. */
  stepFrame(): FrameResult | null {
    if (this.position === this.totalFrames) return null;
    this.before = cloneRoom(this.current);
    const next = applyFrame(this.current, this.replay.frames[this.position]);
    this.current = next.room;
    this.position++;
    return next.result;
  }

  /** Plays `ms` of wall time at the current speed and returns the frames applied; pauses at the end. */
  advance(ms: number): FrameResult[] {
    if (!this.running) return [];
    this.carry += (ms * this.rate * TICKS_PER_SECOND) / 1000;
    const results: FrameResult[] = [];
    while (this.carry >= 1 && this.position < this.totalFrames) {
      this.carry--;
      results.push(this.stepFrame() as FrameResult);
    }
    if (this.position === this.totalFrames) this.pause();
    return results;
  }

  /** Jumps to `frame` (clamped) from the nearest keyframe, or from the current frame when that is closer. */
  seek(frame: number): void {
    const target = Math.min(Math.max(Math.round(frame), 0), this.totalFrames);
    const k = Math.floor(target / this.keyframeInterval);
    if (target < this.position || this.position < k * this.keyframeInterval) {
      this.current = cloneRoom(this.keyframes[k]);
      this.before = this.current;
      this.position = k * this.keyframeInterval;
    }
    while (this.position < target) this.stepFrame();
    this.carry = 0;
  }
}
