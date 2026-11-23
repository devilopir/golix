import { describe, expect, it } from 'vitest';
import { summarizeReports } from '../src/report.ts';
import type { NetReport } from '../src/server.ts';

const report = (fields: Partial<NetReport>): NetReport => ({ path: 'p2p', seconds: 3600, ping: null, inputDelay: null, stalls: 0, desyncs: 0, extrapolation: 0, country: 'tr', ...fields });

describe('summarizeReports', () => {
  it('gives totals, then each path and country busiest first, with medians of the sessions and rates per hour', () => {
    const rows = summarizeReports([
      report({ ping: { n: 1, p50: 30, p95: 40, max: 50 }, stalls: 4 }),
      report({ ping: { n: 1, p50: 50, p95: 90, max: 99 }, stalls: 2, desyncs: 2 }),
      report({ path: 'relay', seconds: 1800, country: 'de', inputDelay: { n: 1, p50: 80, p95: 120, max: 130 } }),
    ]);
    expect(rows.map((r) => r.group)).toEqual(['all', 'path p2p', 'path relay', 'country tr', 'country de']);
    expect(rows[0]).toEqual({ group: 'all', sessions: 3, hours: 2.5, ping: { p50: 50, p95: 90 }, inputDelay: { p50: 80, p95: 120 }, stallsPerHour: 2.4, desyncsPerHour: 0.8 });
    expect(rows[2]).toMatchObject({ sessions: 1, hours: 0.5, ping: null, stallsPerHour: 0 });
  });
});
