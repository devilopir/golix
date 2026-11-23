import { HBInit, JoinError, joinRoom } from '@golix/headless';
import { trimReplay } from '@golix/replay';
import { expect, it } from 'vitest';
import golix from '../src/index.ts';

it('resolves to HBInit when called, like haxball.js, and carries the other entry points', async () => {
  expect(await golix()).toBe(HBInit);
  expect([golix.HBInit, golix.joinRoom, golix.JoinError, golix.trimReplay]).toEqual([HBInit, joinRoom, JoinError, trimReplay]);
});
