import type { Schedule } from '@golix/room';

/** The page side of clockWorker.ts: a delay in ms arms its one timer, null disarms it, and it answers when it fires. */
export interface ClockWorker {
  postMessage(delayMs: number | null): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

/**
 * Runs one timer at a time in a dedicated worker. Hidden tabs throttle the page's own timers to about once a second,
 * but Chrome and release Firefox leave dedicated worker timers alone. `onLate` gets how late each timer fired.
 */
export function workerSchedule(worker: ClockWorker, onLate: (lateMs: number) => void): Schedule {
  let pending: { run: () => void; due: number } | null = null;
  worker.onmessage = () => {
    const fired = pending;
    pending = null;
    if (fired === null) return;
    onLate(performance.now() - fired.due);
    fired.run();
  };
  return (run, delayMs) => {
    const armed = { run, due: performance.now() + delayMs };
    pending = armed;
    worker.postMessage(delayMs);
    return () => {
      if (pending !== armed) return;
      pending = null;
      worker.postMessage(null);
    };
  };
}

/** A dedicated worker for workerSchedule; terminate it once the room is closed. */
export function startClockWorker(): Worker {
  return new Worker(new URL('./clockWorker.ts', import.meta.url), { type: 'module' });
}
