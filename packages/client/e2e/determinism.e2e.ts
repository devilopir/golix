import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { runBotMatch, TICKS } from '../../shared/test/game/botMatch.ts';

const botMatchPath = fileURLToPath(new URL('../../shared/test/game/botMatch.ts', import.meta.url));

test('the 10,000-tick bot match hashes the same in this browser as in Node', async ({ page }) => {
  await page.goto('/');
  const browserHash = await page.evaluate(
    async ({ path, ticks }) => {
      const m = await import(/* @vite-ignore */ `/@fs${path}`);
      return m.runBotMatch(ticks).hash as number;
    },
    { path: botMatchPath, ticks: TICKS },
  );
  expect(browserHash).toBe(runBotMatch(TICKS).hash);
});
