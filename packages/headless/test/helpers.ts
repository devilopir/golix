import type { Room } from '@golix/room';
import { createServer, type GolixServer } from '@golix/server';
import { afterEach, vi } from 'vitest';
import { FakePeer, testKey } from '../../room/test/helpers.ts';
import { HBInit, type RoomConfigObject, type RoomObject } from '../src/index.ts';

export { FakePeer, testKey };

let server: GolixServer | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
});

export interface Harness {
  room: RoomObject;
  /** The server room behind the headless room; its timer is frozen so tests step it by hand. */
  inner: Room;
  id: string;
  tick(n?: number): void;
  join(name: string, opts?: { password?: string }): FakePeer;
}

export async function headless(config: RoomConfigObject = {}): Promise<Harness> {
  server = await createServer({ port: 0, host: '127.0.0.1' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const room = HBInit({ noPlayer: true, ...config, server });
  const [[id, inner]] = [...server.rooms];
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) inner.runTick();
  };
  const join = (name: string, opts: { password?: string } = {}) => {
    const peer = new FakePeer(inner);
    peer.join(name, opts);
    tick();
    return peer;
  };
  return { room, inner, id, tick, join };
}
