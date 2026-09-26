/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { ensureUser, expectNoHorizontalScroll, login, watchConsole, withDb } from './helpers.js';

let cspProblems: string[] = [];
test.beforeEach(({ context }) => {
  cspProblems = watchConsole(context);
});
test.afterEach(() => {
  expect(cspProblems, 'console messages about the Content Security Policy').toEqual([]);
});

const storedFeeds = () =>
  withDb((db) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'feeds'").get() as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Record<string, boolean>) : {};
  });

test('Settings → Feeds: toggles persist; "Test feed" shows one result line per adapter', async ({ page }) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/feeds');
  await expect(page.getByRole('heading', { level: 2, name: 'Feeds' })).toBeVisible();
  await expect(page.locator('[data-testid^="feed-"]').filter({ has: page.getByRole('switch') })).toHaveCount(
    2,
  );

  const nhl = () => page.getByRole('switch', { name: 'NHL official API enabled' });
  await expect(nhl()).toBeChecked();
  await nhl().click();
  await expect(nhl()).not.toBeChecked();
  await page.reload();
  await expect(nhl()).not.toBeChecked();
  expect(storedFeeds()).toMatchObject({ 'nhl-official': false });
  await nhl().click();
  await expect(nhl()).toBeChecked();
  await page.reload();
  await expect(nhl()).toBeChecked();
  expect(storedFeeds()).toMatchObject({ 'nhl-official': true });

  await page.getByRole('button', { name: 'Test feed' }).click();
  const results = page.getByTestId('feed-test-results');
  await expect(results.locator('li')).toHaveCount(2);
  await expect(page.getByTestId('feed-test-kalshi-live')).toContainText('Kalshi live data: OK');
  await expect(page.getByTestId('feed-test-nhl-official')).toContainText(
    'NHL official API: OK — 3 NHL game(s) today',
  );
  await expectNoHorizontalScroll(page);
});
