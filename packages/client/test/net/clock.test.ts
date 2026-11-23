import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerSchedule, type ClockWorker } from '../../src/net/clock.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeWorker() {
  const posted: (number | null)[] = [];
  const worker: ClockWorker & { fire(): void } = {
    onmessage: null,
    postMessage: (delayMs) => void posted.push(delayMs),
    fire: () => worker.onmessage!(new MessageEvent('message', { data: null })),
  };
  return { worker, posted };
}

describe('worker clock', () => {
  it('arms the worker timer, runs the callback when it fires and reports how late it was', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const { worker, posted } = fakeWorker();
    const late: number[] = [];
    const schedule = workerSchedule(worker, (ms) => late.push(ms));
    const run = vi.fn();
    schedule(run, 16);
    expect(posted).toEqual([16]);

    now.mockReturnValue(1116);
    worker.fire();
    expect(run).toHaveBeenCalledOnce();
    expect(late).toEqual([1000]);
    worker.fire();
    expect(run).toHaveBeenCalledOnce();
  });

  it('disarms the worker timer on cancel and ignores a message already on its way', () => {
    const { worker, posted } = fakeWorker();
    const run = vi.fn();
    const cancel = workerSchedule(worker, () => {})(run, 16);
    cancel();
    worker.fire();
    expect(posted).toEqual([16, null]);
    expect(run).not.toHaveBeenCalled();
  });
});
