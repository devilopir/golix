import { expect, test } from '@playwright/test';

test('the developer links are clickable on the nickname screen and the room list, and hidden in a room', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.dk-nickname')).toBeVisible();
  const link = page.getByRole('link', { name: 'For developers' });
  await expect(link).toHaveAttribute('href', '/docs/');
  // A click that lands on a covering layer instead fails here, as it did behind the dialog backdrop.
  await link.click({ trial: true });
  await page.locator('.dk-nickname input').fill('alice');
  await page.locator('.dk-nickname').getByRole('button', { name: 'Ok' }).click();
  await expect(page.locator('.dk-room-list')).toBeVisible();
  await page.getByRole('link', { name: 'Host a bot room' }).click({ trial: true });
  await page.getByRole('button', { name: 'Create Room' }).click();
  await page.locator('.dk-create-room').getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.dk-room-screen')).toBeVisible();
  await expect(page.locator('.dk-site-links')).toBeHidden();
});
