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

const SERIES = {
  nhl: 'KXNHLGAME',
  epl: 'KXEPLGAME',
  laliga: 'KXLALIGAGAME',
  bundesliga: 'KXBUNDESLIGAGAME',
  seriea: 'KXSERIEAGAME',
  ligue1: 'KXLIGUE1GAME',
};

test('Settings → Leagues: six leagues, discover series, include preseason persists', async ({ page }) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/leagues');
  await expect(page.getByRole('heading', { level: 2, name: 'Leagues' })).toBeVisible();

  await expect(page.locator('.league-card')).toHaveCount(6);
  for (const [id, series] of Object.entries(SERIES)) {
    await expect(page.getByTestId(`league-${id}`).getByLabel('Kalshi series')).toHaveValue(series);
  }

  // "Discover series" (the Kalshi stand-in answers from fixtures).
  await page.getByRole('button', { name: 'Discover series' }).click();
  const list = page.getByTestId('discovered-series');
  for (const series of Object.values(SERIES))
    await expect(list.getByText(series, { exact: true })).toBeVisible();
  await expect(list.getByText('KXNHLTOTAL')).toHaveCount(0);

  // Include preseason persists (read from the page, the API and the database), then is restored.
  const nhl = page.getByTestId('league-nhl').getByRole('checkbox', { name: /include preseason/ });
  await expect(nhl).toHaveCount(1);
  const initial = await nhl.isChecked();
  await nhl.click();
  await expect(nhl).toBeChecked({ checked: !initial });
  await page.reload();
  await expect(
    page.getByTestId('league-nhl').getByRole('checkbox', { name: /include preseason/ }),
  ).toBeChecked({
    checked: !initial,
  });
  expect(
    withDb(
      (db) =>
        (db.prepare("SELECT include_preseason AS v FROM leagues WHERE id = 'nhl'").get() as { v: number }).v,
    ),
  ).toBe(initial ? 0 : 1);
  await page
    .getByTestId('league-nhl')
    .getByRole('checkbox', { name: /include preseason/ })
    .click();
  await expect(
    page.getByTestId('league-nhl').getByRole('checkbox', { name: /include preseason/ }),
  ).toBeChecked({
    checked: initial,
  });

  // Run discovery now: games from the fixtures.
  await page.getByRole('button', { name: 'Run discovery now' }).click();
  await expect(page.getByTestId('discovery-result')).toContainText('KXEPLGAME');
  expect(
    withDb((db) => (db.prepare('SELECT count(*) AS n FROM games').get() as { n: number }).n),
  ).toBeGreaterThanOrEqual(2);
  await expectNoHorizontalScroll(page);
});

test('Settings → Diagnostics: Test Kalshi connection shows demo and a balance', async ({ page }) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/diagnostics');
  await page.getByRole('button', { name: 'Test Kalshi connection' }).click();
  const result = page.getByTestId('kalshi-test');
  await expect(result).toContainText('demo');
  await expect(page.getByTestId('kalshi-balance')).toHaveText('$123.45');
  await expect(result).toContainText('trading active');
  await expectNoHorizontalScroll(page);
});
