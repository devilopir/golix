// Summarizes the connection reports in a TELEMETRY_FILE:
// node --experimental-strip-types packages/server/src/report.ts /data/telemetry.jsonl
import { readFileSync } from 'node:fs';
import type { NetReport } from './server.ts';

export interface GroupSummary {
  group: string;
  sessions: number;
  hours: number;
  /** Medians across sessions of each session's p50 and p95. */
  ping: { p50: number; p95: number } | null;
  inputDelay: { p50: number; p95: number } | null;
  stallsPerHour: number;
  desyncsPerHour: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function summarizeGroup(group: string, reports: NetReport[]): GroupSummary {
  const hours = reports.reduce((s, r) => s + r.seconds, 0) / 3600;
  const of = (pick: (r: NetReport) => NetReport['ping']) => {
    const set = reports.map(pick).filter((s) => s !== null);
    return set.length === 0 ? null : { p50: median(set.map((s) => s.p50)), p95: median(set.map((s) => s.p95)) };
  };
  const perHour = (n: number) => (hours === 0 ? 0 : Math.round((n / hours) * 10) / 10);
  return {
    group,
    sessions: reports.length,
    hours: Math.round(hours * 10) / 10,
    ping: of((r) => r.ping),
    inputDelay: of((r) => r.inputDelay),
    stallsPerHour: perHour(reports.reduce((s, r) => s + r.stalls, 0)),
    desyncsPerHour: perHour(reports.reduce((s, r) => s + r.desyncs, 0)),
  };
}

/** One row for everything, then one per connection path and per country, busiest first. */
export function summarizeReports(reports: NetReport[]): GroupSummary[] {
  const by = (key: (r: NetReport) => string) => {
    const groups = new Map<string, NetReport[]>();
    for (const r of reports) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    return [...groups].map(([g, rs]) => summarizeGroup(g, rs)).sort((a, b) => b.sessions - a.sessions);
  };
  return [summarizeGroup('all', reports), ...by((r) => `path ${r.path}`), ...by((r) => `country ${r.country || '??'}`)];
}

if (import.meta.main) {
  const lines = readFileSync(process.argv[2] ?? '/data/telemetry.jsonl', 'utf8').split('\n').filter((l) => l !== '');
  console.table(summarizeReports(lines.map((l) => JSON.parse(l) as NetReport)).map(({ ping, inputDelay, ...rest }) => ({
    ...rest,
    ping: ping === null ? '-' : `${ping.p50} / ${ping.p95}`,
    inputDelay: inputDelay === null ? '-' : `${inputDelay.p50} / ${inputDelay.p95}`,
  })));
}
