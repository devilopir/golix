import { ProtocolError, Reader, Writer, readEvent, readRoom, writeEvent, writeRoom, type RoomEvent, type RoomState } from '@golix/shared';

export const REPLAY_EXTENSION = '.glx';
export const REPLAY_VERSION = 4;
export const REPLAY_LOAD_ERROR = "Couldn't load the file.";
const MAGIC = [0x47, 0x4c, 0x58, 0x52];
/** Twelve hours at 60 frames per second; bounds the memory a hostile header can ask for. */
const MAX_FRAMES = 12 * 60 * 60 * 60;
const EVENTS = 0;
const SNAPSHOT = 1;

/** One confirmed tick: its events, or the full room that replaced the state after a resync. */
export type ReplayFrame = { kind: 'events'; events: readonly RoomEvent[] } | { kind: 'snapshot'; room: RoomState };

/** A player's own ping handicap, in effect from `frame` on; peers never see it, so only the recorder's is known. */
export interface ReplayHandicap {
  frame: number;
  playerId: number;
  ms: number;
}

export interface Replay {
  start: RoomState;
  frames: ReplayFrame[];
  handicaps: ReplayHandicap[];
}

export class ReplayError extends Error {}

const EMPTY: ReplayFrame = Object.freeze({ kind: 'events', events: Object.freeze([]) });

export function encodeReplay(replay: Replay): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  for (const b of MAGIC) w.u8(b);
  w.uint(REPLAY_VERSION);
  w.uint(replay.frames.length);
  writeRoom(w, replay.start);
  w.uint(replay.handicaps.length);
  for (const { frame, playerId, ms } of replay.handicaps) {
    w.uint(frame);
    w.uint(playerId);
    w.uint(ms);
  }
  let gap = 0;
  for (const frame of replay.frames) {
    if (frame.kind === 'events' && frame.events.length === 0) {
      gap++;
      continue;
    }
    w.uint(gap);
    gap = 0;
    if (frame.kind === 'snapshot') {
      w.u8(SNAPSHOT);
      writeRoom(w, frame.room);
    } else {
      w.u8(EVENTS);
      w.uint(frame.events.length);
      for (const ev of frame.events) writeEvent(w, ev);
    }
  }
  return w.finish();
}

function readFrames(r: Reader, count: number): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  while (r.remaining > 0) {
    const gap = r.uint();
    if (frames.length + gap >= count) throw new ProtocolError('more frames than the header declares');
    for (let i = 0; i < gap; i++) frames.push(EMPTY);
    const kind = r.u8();
    if (kind === SNAPSHOT) {
      frames.push({ kind: 'snapshot', room: readRoom(r) });
    } else if (kind === EVENTS) {
      const events: RoomEvent[] = [];
      for (let i = r.count(); i > 0; i--) events.push(readEvent(r));
      frames.push({ kind: 'events', events });
    } else {
      throw new ProtocolError(`unknown frame kind ${kind}`);
    }
  }
  while (frames.length < count) frames.push(EMPTY);
  return frames;
}

/** Throws a ReplayError whose message is fit to show the user under a "Replay error" title. */
export function decodeReplay(data: Uint8Array | ArrayBuffer): Replay {
  const r = new Reader(data);
  try {
    if (r.remaining < MAGIC.length || MAGIC.some((b) => r.u8() !== b)) throw new ReplayError(REPLAY_LOAD_ERROR);
    const version = r.uint();
    if (version < REPLAY_VERSION) throw new ReplayError('Incompatible replay version');
    if (version > REPLAY_VERSION) throw new ReplayError('The replay file is of a different version');
    const count = r.uint();
    if (count > MAX_FRAMES) throw new ProtocolError(`${count} frames is more than the ${MAX_FRAMES} allowed`);
    const start = readRoom(r);
    const handicaps: ReplayHandicap[] = [];
    for (let i = r.count(); i > 0; i--) {
      const handicap = { frame: r.uint(), playerId: r.uint(), ms: r.uint() };
      if (handicap.frame > count) throw new ProtocolError(`handicap at frame ${handicap.frame} is past the end`);
      handicaps.push(handicap);
    }
    return { start, frames: readFrames(r, count), handicaps };
  } catch (e) {
    if (e instanceof ReplayError) throw e;
    throw new ReplayError((e as Error).message);
  }
}
