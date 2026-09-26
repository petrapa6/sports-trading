/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ensureUser, expectNoHorizontalScroll, login, watchConsole, withDb } from './helpers.js';

/**
 * T10: the Dashboard tiles and the eight Recharts charts on `test/fixtures/db/stats-seed.sql`, plus the
 * Trades page charts. The e2e database is shared by every spec, so this one empties the trade tables for
 * the empty-state check, loads the seed, and removes the seed rows again at the end.
 */
const SEED = readFileSync(resolve(import.meta.dirname, '../fixtures/db/stats-seed.sql'), 'utf8');
const CHARTS = [
  'equity',
  'daily-pnl',
  'drawdown',
  'implied-vs-actual',
  'price-histogram',
  'trades-per-minute',
  'skip-reasons',
  'balance-history',
] as const;

let cspProblems: string[] = [];
test.beforeEach(({ context }) => {
  cspProblems = watchConsole(context);
});
test.afterEach(() => {
  expect(cspProblems, 'console messages about the Content Security Policy').toEqual([]);
});

function clearTradeData(): void {
  withDb((db) =>
    db.exec(`
      DELETE FROM trade_attempts;
      DELETE FROM trades;
      DELETE FROM bankroll_snapshots;
      DELETE FROM balance_snapshots;
      DELETE FROM strategy_versions WHERE strategy_id IN ('A', 'B');
      DELETE FROM strategies WHERE id IN ('A', 'B');
    `),
  );
}

async function openDashboard(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('stats-tiles')).toBeVisible();
}

test('Dashboard: tiles and eight charts split by mode; empty states; dark palette; Trades page charts follow the filter', async ({
  page,
}) => {
  await ensureUser(page);
  await login(page);

  // Empty database: every chart shows its empty state, tiles show zeros.
  clearTradeData();
  await openDashboard(page);
  for (const id of CHARTS) await expect(page.getByTestId(`chart-${id}-empty`)).toBeVisible();
  await expect(page.locator('.recharts-wrapper')).toHaveCount(0);
  await expect(page.getByTestId('tile-trades').locator('.stat-number')).toHaveText(['0', '0']);
  await expectNoHorizontalScroll(page);

  // Seeded database, mode = both.
  withDb((db) => db.exec(SEED));
  await openDashboard(page);
  await expect(page.locator('.recharts-wrapper')).toHaveCount(8);
  for (const id of CHARTS) {
    const legend = page.getByTestId(`chart-${id}`).locator('.recharts-legend-wrapper');
    await expect(legend, id).toContainText('Live');
    await expect(legend, id).toContainText('Dry run');
  }
  const tiles = page.locator('[data-testid^="tile-"]');
  expect(await tiles.count()).toBeGreaterThanOrEqual(7);
  for (const tile of await tiles.all()) {
    await expect(tile.locator('.stat-value')).toHaveCount(2);
  }
  await expect(page.getByTestId('tile-trades').locator('.stat-number')).toHaveText(['8', '11']);
  await expect(page.getByTestId('tile-net-pnl').locator('.stat-number')).toHaveText(['−$1.30', '−$3.00']);
  await expectNoHorizontalScroll(page);

  // Skip reasons: the per-attempt toggle.
  const skips = page.getByTestId('chart-skip-reasons');
  await skips.getByRole('button', { name: 'Per attempt' }).click();
  await expect(skips.getByRole('button', { name: 'Per attempt' })).toHaveAttribute('aria-pressed', 'true');
  await expect(skips.locator('.recharts-wrapper')).toHaveCount(1);

  // Dark mode changes the series colours.
  const equityStroke = () =>
    page.getByTestId('chart-equity').locator('path.recharts-line-curve').first().getAttribute('stroke');
  const light = await equityStroke();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(equityStroke).not.toBe(light);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(equityStroke).toBe(light);

  // Mode = live (the filter bar): no "Dry run" text in any chart, one value per tile.
  await page.getByText('Live', { exact: true }).first().click();
  await expect(page).toHaveURL(/mode=live/);
  await expect(page.getByTestId('tile-trades').locator('.stat-number')).toHaveText(['8']);
  await expect(page.locator('.recharts-wrapper')).toHaveCount(8);
  await expect(page.getByTestId('stats-charts')).not.toContainText('Dry run');
  await expectNoHorizontalScroll(page);

  // Trades page: histogram and per-trade bars follow the filter; hovering a bar names the trade and its mode.
  for (const query of ['', '?strategies=A', '?mode=dry_run']) {
    await page.goto(`/trades${query}`);
    await expect(page.getByTestId('trades-table')).toBeVisible();
    const settledRows = await page
      .locator('[data-testid^="status-"]')
      .filter({ hasText: /^(Won|Lost|Void)$/ })
      .count();
    const bars = page
      .getByTestId('chart-trade-pnl')
      .locator('.recharts-bar-rectangle path.recharts-rectangle');
    await expect(bars).toHaveCount(settledRows);
    const filledRows = await page
      .locator('[data-testid^="status-"]')
      .filter({ hasText: /^(Filled|Won|Lost|Void)$/ })
      .count();
    const histogram = page
      .getByTestId('chart-trade-histogram')
      .locator('.recharts-bar-rectangle path.recharts-rectangle');
    expect(await histogram.count()).toBeGreaterThan(0);
    expect(await histogram.count()).toBeLessThanOrEqual(filledRows);
  }
  const bars = page.getByTestId('chart-trade-pnl').locator('.recharts-bar-rectangle path.recharts-rectangle');
  await bars.first().hover();
  const tooltip = page.getByTestId('trade-pnl-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(/Trade stats-t\d\d/);
  await expect(tooltip).toContainText('Dry run');
  await expectNoHorizontalScroll(page);

  clearTradeData();
});
