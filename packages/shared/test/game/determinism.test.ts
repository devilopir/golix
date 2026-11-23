import { describe, expect, it } from 'vitest';
import { applyEvent, cloneRoom, hashRoom, stepRoom, type TickOutcome } from '../../src/game/index.ts';
import { PROTOCOL_VERSION, encodeServerMessage } from '../../src/protocol/index.ts';
import type { RoomEvent } from '../../src/types.ts';
import { botEvents, prng, runBotMatch, setup, TICKS } from './botMatch.ts';
import { send } from './helpers.ts';

describe('room determinism', () => {
  it('two rooms fed the same events hash equal for 10,000 ticks, and a clone replays the second half', () => {
    const a = setup();
    const b = setup();
    const start = hashRoom(a);
    const rand = prng(42);
    const script: RoomEvent[][] = [];
    const outcomes: TickOutcome[] = [];
    let mid = a;
    for (let t = 0; t < TICKS; t++) {
      if (t === TICKS / 2) mid = cloneRoom(a);
      const events = botEvents(a, t, rand);
      script.push(events);
      send(a, events);
      send(b, events);
      outcomes.push(...stepRoom(a));
      stepRoom(b);
      if (t % 1000 === 0) expect(hashRoom(a)).toBe(hashRoom(b));
    }
    expect(hashRoom(a)).toBe(hashRoom(b));
    expect(hashRoom(a)).not.toBe(start);
    expect(outcomes.filter((o) => o.type === 'kick').length).toBeGreaterThan(50);
    expect(outcomes.some((o) => o.type === 'goal')).toBe(true);

    const midHash = hashRoom(mid);
    const replay = cloneRoom(mid);
    for (let t = TICKS / 2; t < TICKS; t++) {
      send(replay, script[t]);
      stepRoom(replay);
    }
    expect(hashRoom(replay)).toBe(hashRoom(a));
    expect(hashRoom(mid)).toBe(midHash);
  });
});

// The browser e2e (packages/client/e2e/determinism.e2e.ts) checks Chromium and Firefox reach the same value.
const BOT_MATCH_HASH = 2148042694;

describe('cross-engine reference', () => {
  it('the scripted 10,000-tick bot match ends on a fixed hash in Node', () => {
    expect(runBotMatch(TICKS).hash).toBe(BOT_MATCH_HASH);
  });
});

describe('protocol version', () => {
  /** FNV-1a over the bot match hash and the wire bytes of a room that uses every Golix field. */
  function fingerprint(): number {
    const room = setup();
    for (const ev of [
      { type: 'setHudItem', id: 'hud', item: { text: 'x', x: 0.5, y: 0.5, align: 'right', color: 1, size: 9 } },
      { type: 'setCamera', camera: { follow: { type: 'disc', index: 0 }, zoom: 2 } },
      { type: 'setPlayerPhysics', playerId: 1, physics: { kickStrength: 6 } },
      { type: 'setPlayerColors', playerId: 2, colors: { angle: 30, textColor: 0, colors: [1, 2] } },
      { type: 'setTeamName', team: 1, name: 'Lions' },
      { type: 'addJoint', joint: { a: { disc: 0 }, b: { player: 1 }, length: [20, 90], strength: 0.2, color: -1, breakLength: 400 } },
    ] as RoomEvent[]) applyEvent(room, ev);
    for (let t = 0; t < 120; t++) stepRoom(room);
    let h = 0x811c9dc5;
    for (const b of [...encodeServerMessage({ type: 'snapshot', tick: 1, room }), runBotMatch(TICKS).hash]) h = Math.imul(h ^ b, 0x01000193);
    return h >>> 0;
  }

  it('is bumped with every change to the engine or the wire format', () => {
    // A failure here means peers of the last version would desync with this one: bump PROTOCOL_VERSION, then pin both.
    expect([PROTOCOL_VERSION, fingerprint()]).toEqual([3, 4042218154]);
  });
});
