import type { NetSession } from './netSession.ts';

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

/** What one session tells the lobby about its connection; nothing in it names the player or the room. */
export interface NetReport {
  v: 1;
  path: 'p2p' | 'relay';
  seconds: number;
  ping: Summary | null;
  /** From sending an input to the room confirming it. */
  inputDelay: Summary | null;
  /** Ping reports that never came, the red bars of the graph. */
  stalls: number;
  desyncs: number;
  extrapolation: number;
}

/** The room reports pings every 2 seconds. */
const PING_EVENT_MS = 2000;

export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted[sorted.length - 1]!) };
}

/** Follows a joined session's pings; the returned function builds its report. */
export function watchNetStats(session: NetSession, extrapolation: () => number): () => NetReport {
  const started = performance.now();
  const pings: number[] = [];
  let stalls = 0;
  let last: number | null = null;
  session.onEvent((ev) => {
    if (ev.type !== 'ping') return;
    const own = ev.pings.find(([id]) => id === session.playerId);
    if (own === undefined) return;
    const now = performance.now();
    if (last !== null) stalls += Math.max(0, Math.round((now - last) / PING_EVENT_MS) - 1);
    last = now;
    pings.push(own[1]);
  });
  return () => ({
    v: 1,
    path: session.path === 'p2p' ? 'p2p' : 'relay',
    seconds: Math.round((performance.now() - started) / 1000),
    ping: summarize(pings),
    inputDelay: summarize(session.inputDelays),
    stalls,
    desyncs: session.sync.desyncs,
    extrapolation: extrapolation(),
  });
}
