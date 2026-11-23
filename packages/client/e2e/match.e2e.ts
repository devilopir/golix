import { expect, test, type Page } from '@playwright/test';

type PlayerPos = { id: number; team: number; x: number; y: number };

async function enterNickname(page: Page, nick: string): Promise<void> {
  await page.locator('.dk-nickname input').fill(nick);
  await page.locator('.dk-nickname').getByRole('button', { name: 'Ok' }).click();
}

function debug(page: Page) {
  return {
    ready: () => page.waitForFunction(() => window.__golix !== undefined),
    players: () =>
      page.evaluate(() =>
        (window.__golix!.room().game?.players ?? []).flatMap((p): PlayerPos[] => (p.disc ? [{ id: p.id, team: p.team, x: p.disc.pos.x, y: p.disc.pos.y }] : [])),
      ),
    tick: () => page.evaluate(() => window.__golix!.tick()),
    hashAt: (tick: number) => page.evaluate((t) => window.__golix!.hashAt(t), tick),
    desyncs: () => page.evaluate(() => window.__golix!.sync.desyncs),
  };
}

test('a browser hosts the room and a second one joins by link over a WebRTC data channel, plays and chats', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const errors: Error[] = [];
  for (const page of [a, b]) page.on('pageerror', (e) => errors.push(e));
  const da = debug(a);
  const db = debug(b);

  await a.goto('/');
  await enterNickname(a, 'alice');
  await a.getByRole('button', { name: 'Create Room' }).click();
  await a.locator('.dk-create-room').getByRole('button', { name: 'Create' }).click();
  await expect(a.locator('.dk-room-screen')).toBeVisible();
  await da.ready();

  await a.getByRole('button', { name: 'Link', exact: true }).click();
  const link = await a.locator('.dk-dialog input').inputValue();
  await a.getByRole('button', { name: 'Close' }).click();
  expect(link).toMatch(/\/play\?c=[\w-]{11}$/);

  await b.goto(link);
  await enterNickname(b, 'bob');
  await expect(b.locator('.dk-room-screen')).toBeVisible();
  await db.ready();

  await a.locator('.dk-team-red .dk-team-header').click();
  await a.locator('.dk-team-spectators .dk-player', { hasText: 'bob' }).dragTo(a.locator('.dk-team-blue'));
  await expect(b.locator('.dk-team-blue .dk-player', { hasText: 'bob' })).toBeVisible();
  await expect(b.locator('.dk-team-red .dk-player', { hasText: 'alice' })).toBeVisible();

  await a.getByRole('button', { name: 'Start game' }).click();
  for (const page of [a, b]) {
    await expect(page.locator('.dk-room-overlay')).toBeHidden();
    await expect(page.locator('.dk-game-canvas')).toBeVisible();
  }
  await expect(a.locator('.dk-stats')).toHaveAttribute('title', 'Connection: host');
  await expect(b.locator('.dk-stats')).toHaveAttribute('title', 'Connection: p2p');
  const start = await da.players();
  expect(start.map((p) => p.team).sort()).toEqual([1, 2]);

  await a.keyboard.down('ArrowRight');
  await b.keyboard.down('ArrowUp');
  await a.waitForTimeout(700);
  await a.keyboard.up('ArrowRight');
  await b.keyboard.up('ArrowUp');
  await a.waitForTimeout(300);

  const red = start.find((p) => p.team === 1)!;
  const blue = start.find((p) => p.team === 2)!;
  for (const page of [da, db]) {
    const now = await page.players();
    expect(now.find((p) => p.id === red.id)!.x).toBeGreaterThan(red.x + 30);
    expect(now.find((p) => p.id === blue.id)!.y).toBeLessThan(blue.y - 30);
  }

  const tick = Math.min(await da.tick(), await db.tick());
  const hashA = await da.hashAt(tick);
  expect(hashA).toBeDefined();
  expect(await db.hashAt(tick)).toBe(hashA);
  expect(await da.desyncs()).toBe(0);
  expect(await db.desyncs()).toBe(0);

  await b.keyboard.press('Enter');
  await b.keyboard.type('hello from bob');
  await b.keyboard.press('Enter');
  await expect(a.locator('.dk-chat-line', { hasText: 'bob: hello from bob' })).toBeVisible();

  await a.close();
  const disconnected = b.locator('.dk-dialog', { hasText: 'Disconnected' });
  await expect(disconnected).toBeVisible();
  await disconnected.getByRole('button').first().click();
  await b.getByRole('button', { name: 'Replays' }).click();
  await expect(b.locator('.dk-saved-replays li')).toHaveCount(1);
  await b.locator('.dk-saved-replays').getByRole('button', { name: 'Watch' }).click();
  await expect(b.locator('.dk-replay-view')).toBeVisible();
  expect(errors).toEqual([]);
});
