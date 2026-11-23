import { REPLAY_EXTENSION, ReplayRecorder } from '@golix/replay';
import type { RoomEvent } from '@golix/shared';
import type { RoomSession } from '../session.ts';

/** Records every confirmed tick and the local `handicap` from now on; the returned function stops and yields the replay file. */
export function recordSession(session: RoomSession, handicap: () => number): () => Uint8Array<ArrayBuffer> {
  const recorder = new ReplayRecorder(session.getRoom());
  let events: RoomEvent[] = [];
  const offEvents = session.onEvent((ev) => events.push(ev));
  const offTicks = session.onTick(() => {
    recorder.setHandicap(session.playerId, handicap());
    recorder.tick(events, session.getRoom());
    events = [];
  });
  const offResync = session.onResync(() => recorder.resync());
  return () => {
    offEvents();
    offTicks();
    offResync();
    return recorder.finish();
  };
}

/**
 * Records each game from its first tick to its last, handing over the replay and its length in ticks; the returned
 * function stops, handing over a game still running.
 */
export function recordMatches(session: RoomSession, handicap: () => number, save: (data: Uint8Array<ArrayBuffer>, ticks: number) => void): () => void {
  let stop: (() => Uint8Array<ArrayBuffer>) | null = null;
  let ticks = 0;
  let queued = false;
  let ended = false;
  const finish = () => {
    if (stop === null) return;
    const data = stop();
    stop = null;
    if (ticks > 0) save(data, ticks);
  };
  // A recorder started or stopped from inside a tick would hear that tick half, so it changes between ticks.
  const settle = () => {
    queued = false;
    if (ended) return;
    const playing = session.getRoom().game !== null;
    if (playing && stop === null) {
      stop = recordSession(session, handicap);
      ticks = 0;
    } else if (!playing) {
      finish();
    }
  };
  const offTicks = session.onTick(() => {
    if (stop !== null) ticks++;
    if ((session.getRoom().game !== null) === (stop !== null) || queued) return;
    queued = true;
    queueMicrotask(settle);
  });
  return () => {
    ended = true;
    offTicks();
    finish();
  };
}

export function replayFileName(roomName: string, date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}h${two(date.getMinutes())}m`;
  return `${stamp} ${roomName.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')}${REPLAY_EXTENSION}`;
}
