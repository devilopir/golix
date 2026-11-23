import type { ClientMessage, Input, RoomEvent, RoomState, TickOutcome } from '@golix/shared';

export interface RoomSession {
  readonly playerId: number;
  getRoom(): RoomState;
  send(msg: Exclude<ClientMessage, { type: 'input' }>): void;
  /** The session decides which tick the input applies to. */
  sendInput(input: Input): void;
  onEvent(cb: (ev: RoomEvent) => void): () => void;
  /** Called after each server-confirmed tick with the outcomes of its events and step; getRoom() is that tick's state. */
  onTick(cb: (tick: number, outcomes: readonly TickOutcome[]) => void): () => void;
  /** Called after a full-state snapshot replaced getRoom(). */
  onResync(cb: () => void): () => void;
  /** Called once when the connection ends; the reason is 'left' after leave(), else the server's reason or 'closed'. */
  onClose(cb: (reason: string) => void): () => void;
  leave(): void;
}
