import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { ReplayRecorder } from '@golix/replay';
import { Team, applyEvent, createRoomState, stepRoom, type RoomEvent } from '@golix/shared';

const FILE_URL = 'https://replays.example/friday.glx';

function replayFile(): Buffer {
  const room = createRoomState({ name: 'Friday', maxPlayers: 12, hasPassword: false });
  applyEvent(room, { type: 'playerJoin', player: { id: 1, name: 'alice', team: Team.spectators, admin: true, avatar: '', country: 'tr', joinSeq: 1, ping: 0 } });
  const recorder = new ReplayRecorder(room);
  recorder.setHandicap(1, 60);
  for (let t = 0; t < 30 * 60; t++) {
    const events: RoomEvent[] =
      t === 0
        ? [{ type: 'setTeam', playerId: 1, team: Team.red, byPlayer: 1, announce: true }, { type: 'startGame', byPlayer: 1 }, { type: 'ping', pings: [[1, 48]] }]
        : [];
    for (const ev of events) applyEvent(room, ev);
    stepRoom(room);
    recorder.tick(events, room);
  }
  return Buffer.from(recorder.finish());
}

async function serveReplay(page: Page): Promise<void> {
  const body = replayFile();
  await page.route(FILE_URL, (route) => route.fulfill({ body, contentType: 'application/octet-stream', headers: { 'Access-Control-Allow-Origin': '*' } }));
}

test('a replay link opens the viewer, which answers to its keyboard shortcuts', async ({ page }) => {
  await serveReplay(page);
  await page.goto(`/replay?url=${encodeURIComponent(FILE_URL)}`);
  const view = page.locator('.dk-replay-view');
  await expect(view).toBeVisible();
  await expect(view.locator('.dk-replay-players li')).toHaveText('alice060');
  const clock = view.locator('.dk-replay-clock');
  const speed = view.getByLabel('Speed');

  const play = view.getByRole('button', { name: 'Play' });
  await play.click();
  await expect(clock).toHaveText('00:01 / 00:30');
  await page.keyboard.press('Space');
  const paused = await clock.textContent();
  await page.waitForTimeout(1500);
  await expect(clock).toHaveText(paused!);
  await expect(view.getByRole('button', { name: 'Play' })).toBeVisible();
  await expect(view.locator('.dk-replay-players li.red')).toHaveText('alice4860');

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(clock).toHaveText('00:11 / 00:30');
  await page.keyboard.press('ArrowLeft');
  await expect(clock).toHaveText('00:06 / 00:30');

  await page.keyboard.press('ArrowUp');
  await expect(speed.locator('option:checked')).toHaveText('2x');
  await page.keyboard.press('-');
  await page.keyboard.press('ArrowDown');
  await expect(speed.locator('option:checked')).toHaveText('0.5x');

  await page.keyboard.press('Escape');
  await expect(page.locator('.dk-nickname')).toBeVisible();
});

test('a replay link to a file that is not https, missing or not a replay shows the replay error', async ({ page }) => {
  await page.route('https://replays.example/missing.glx', (route) => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('https://replays.example/stadium.hbs', (route) => route.fulfill({ body: '{"name": "x"}', headers: { 'Access-Control-Allow-Origin': '*' } }));
  for (const file of ['http://replays.example/friday.glx', 'https://replays.example/missing.glx', 'https://replays.example/stadium.hbs']) {
    await page.goto(`/replay?url=${encodeURIComponent(file)}`);
    const dialog = page.locator('.dk-dialog');
    await expect(dialog).toContainText('Replay error');
    await expect(dialog).toContainText("Couldn't load the file.");
    await dialog.getByRole('button', { name: 'Ok' }).click();
    await expect(page.locator('.dk-nickname')).toBeVisible();
  }
});

const replayStorePath = fileURLToPath(new URL('../src/net/replayStore.ts', import.meta.url));

test('a replay link with t opens at that second, and a match saved in the browser plays from the Replays list', async ({ page }) => {
  await serveReplay(page);
  await page.goto(`/replay?url=${encodeURIComponent(FILE_URL)}&t=12`);
  await expect(page.locator('.dk-replay-clock')).toHaveText('00:12 / 00:30');
  await page.keyboard.press('Escape');
  await page.locator('.dk-nickname input').fill('alice');
  await page.locator('.dk-nickname').getByRole('button', { name: 'Ok' }).click();

  const bytes = [...replayFile()];
  await page.evaluate(
    async ({ path, bytes }) => {
      const m = await import(/* @vite-ignore */ `/@fs${path}`);
      const store = m.indexedDbReplays(indexedDB);
      for (let i = 0; i < 52; i++) await store.add({ roomName: `Match ${i}`, savedAt: Date.UTC(2026, 10, 9, 20, i), seconds: 30 }, new Uint8Array(bytes));
    },
    { path: replayStorePath, bytes },
  );
  await page.getByRole('button', { name: 'Replays' }).click();
  const rows = page.locator('.dk-saved-replays li');
  await expect(rows).toHaveCount(50);
  await expect(rows.first().locator('.dk-saved-replay-name')).toHaveText('Match 51');
  await expect(rows.last().locator('.dk-saved-replay-name')).toHaveText('Match 2');
  await rows.first().getByRole('button', { name: 'Watch' }).click();
  await expect(page.locator('.dk-replay-clock')).toHaveText('00:00 / 00:30');
});
