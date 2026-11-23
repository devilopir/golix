import { expect, test, type Page } from '@playwright/test';

async function enterNickname(page: Page, nick: string): Promise<void> {
  await page.locator('.dk-nickname input').fill(nick);
  await page.locator('.dk-nickname').getByRole('button', { name: 'Ok' }).click();
}

test('the host room ticks on a worker clock while page timers stall, and joiners hear at once when the host crashes', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();

  await a.goto('/');
  await enterNickname(a, 'alice');
  await a.getByRole('button', { name: 'Create Room' }).click();
  await a.locator('.dk-create-room').getByRole('button', { name: 'Create' }).click();
  await expect(a.locator('.dk-room-screen')).toBeVisible();
  await a.getByRole('button', { name: 'Link', exact: true }).click();
  const link = await a.locator('.dk-dialog input').inputValue();
  await a.getByRole('button', { name: 'Close' }).click();

  await b.goto(link);
  await enterNickname(b, 'bob');
  await expect(b.locator('.dk-room-screen')).toBeVisible();
  await b.waitForFunction(() => window.__golix !== undefined);

  // Stands in for a hidden tab's throttled timers: the page's own timers never fire.
  await a.evaluate(() => {
    window.setTimeout = (() => 0) as unknown as typeof window.setTimeout;
  });
  const before = await b.evaluate(() => window.__golix!.tick());
  await b.waitForTimeout(1000);
  expect((await b.evaluate(() => window.__golix!.tick())) - before).toBeGreaterThan(50);

  const cdp = await a.context().newCDPSession(a);
  const crashedAt = Date.now();
  void cdp.send('Page.crash').catch(() => {});
  await expect(b.locator('.dk-dialog', { hasText: 'Lost the connection to the host' })).toBeVisible({ timeout: 3000 });
  expect(Date.now() - crashedAt).toBeLessThan(3000);
});
