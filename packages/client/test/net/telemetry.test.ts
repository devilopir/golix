import type { RoomEvent } from '@golix/shared';
import { describe, expect, it, vi } from 'vitest';
import type { NetSession } from '../../src/net/netSession.ts';
import { summarize, watchNetStats } from '../../src/net/telemetry.ts';

describe('summarize', () => {
  it('gives the count, median, 95th percentile and maximum, or null without samples', () => {
    expect(summarize([])).toBeNull();
    expect(summarize(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ n: 100, p50: 51, p95: 96, max: 100 });
    expect(summarize([12.4])).toEqual({ n: 1, p50: 12, p95: 12, max: 12 });
  });
});

describe('watchNetStats', () => {
  it('reports own pings, counts missed ping reports as stalls and takes input delays and desyncs from the session', () => {
    vi.useFakeTimers();
    let listener: (ev: RoomEvent) => void = () => {};
    const session = {
      playerId: 2,
      path: 'p2p',
      inputDelays: [40, 50, 60],
      sync: { checked: 9, desyncs: 1 },
      onEvent: (cb: (ev: RoomEvent) => void) => (listener = cb),
    } as unknown as NetSession;
    const report = watchNetStats(session, () => 100);
    const ping = (ms: number) => listener({ type: 'ping', pings: [[1, 5], [2, ms]] });
    ping(30);
    vi.advanceTimersByTime(2000);
    ping(32);
    vi.advanceTimersByTime(8000);
    ping(90);
    listener({ type: 'ping', pings: [[1, 5]] });
    expect(report()).toEqual({ v: 1, path: 'p2p', seconds: 10, ping: { n: 3, p50: 32, p95: 90, max: 90 }, inputDelay: { n: 3, p50: 50, p95: 60, max: 60 }, stalls: 3, desyncs: 1, extrapolation: 100 });
    vi.useRealTimers();
  });
});
