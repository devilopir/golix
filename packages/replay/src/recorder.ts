import { cloneRoom, type RoomEvent, type RoomState } from '@golix/shared';
import { encodeReplay, type ReplayFrame, type ReplayHandicap } from './format.ts';

export class ReplayRecorder {
  private readonly start: RoomState;
  private readonly frames: ReplayFrame[] = [];
  private readonly handicaps: ReplayHandicap[] = [];
  private resynced = false;

  /** `room` is the confirmed state the first recorded tick builds on. */
  constructor(room: RoomState) {
    this.start = cloneRoom(room);
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Marks that a snapshot replaced the state, so the next tick is stored whole. */
  resync(): void {
    this.resynced = true;
  }

  /** Records `playerId`'s handicap from the next tick on when it differs from the last one (0 before any). */
  setHandicap(playerId: number, ms: number): void {
    let last = 0;
    for (const h of this.handicaps) if (h.playerId === playerId) last = h.ms;
    if (ms !== last) this.handicaps.push({ frame: this.frames.length, playerId, ms });
  }

  /** `room` is the confirmed state after this tick's events and step. */
  tick(events: readonly RoomEvent[], room: RoomState): void {
    if (this.resynced) this.frames.push({ kind: 'snapshot', room: cloneRoom(room) });
    else this.frames.push({ kind: 'events', events: [...events] });
    this.resynced = false;
  }

  finish(): Uint8Array<ArrayBuffer> {
    return encodeReplay({ start: this.start, frames: this.frames, handicaps: this.handicaps });
  }
}
