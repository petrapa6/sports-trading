import { expect, test } from '@playwright/test';
import { ensureUser, expectNoHorizontalScroll, login, watchConsole, withDb } from './helpers.js';

/**
 * T13: a live trade on the Trades page — `LIVE` badge with its Kalshi environment, the exchange's fill and fee,
 * and a reconciliation warning in the row and in the expanded detail. The row is written straight into the e2e
 * database (the e2e server runs with `allow_live_orders: false`, so it cannot place live orders itself).
 */
test('Trades: a live trade shows LIVE with environment demo and its reconcile warning', async ({
  page,
  context,
}, info) => {
  const problems = watchConsole(context);
  await ensureUser(page);
  const id = `live-e2e-${info.project.name}`;
  const now = new Date().toISOString();
  withDb((db) => {
    db.prepare('DELETE FROM trades WHERE id = ?').run(id);
    db.prepare(
      `INSERT INTO trades (id, strategy_id, strategy_version, game_id, market_ticker, league_id, kalshi_env,
        configured_mode, effective_mode, mode_reason, status, attempts, trigger_snapshot, triggered_at, window_ends_at,
        fill_cc, avg_fill_price_bp, cost_micros, fee_micros, kalshi_order_id, settled_at, settlement_value_bp,
        payout_micros, realized_pnl_micros, reconcile_warning)
       VALUES (?, 'live-e2e', 1, 'KXNHLGAME-26OCT14SEAVGK', 'KXNHLGAME-26OCT14SEAVGK-VGK', 'nhl', 'demo',
        'live', 'live', NULL, 'settled_won', 1, '{}', ?, ?, 200, 9300, 1860000, 9200, 'ord-e2e', ?, 10000,
        2000000, 130800, 'Kalshi reported revenue $1.9800 for KXNHLGAME-26OCT14SEAVGK-VGK; the app computed $2.0000 (difference -$0.0200)')`,
    ).run(id, now, now, now);
  });
  await login(page);
  await page.goto('/trades?mode=live');
  await expect(page.getByRole('heading', { level: 1, name: 'Trades' })).toBeVisible();
  const row = page.getByTestId(`trade-row-${id}`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`mode-${id}`)).toContainText('LIVE');
  await expect(page.getByTestId(`mode-${id}`)).toContainText('demo');
  await expect(page.getByTestId(`reconcile-${id}`)).toBeVisible();
  await row.getByRole('button', { expanded: false }).click();
  await expect(page.getByText('Reconcile warning')).toBeVisible();
  await expect(page.getByText(/difference -\$0\.0200/).last()).toBeVisible();
  await expectNoHorizontalScroll(page);
  withDb((db) => db.prepare('DELETE FROM trades WHERE id = ?').run(id));
  expect(problems).toEqual([]);
});
