/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { candleMinuteMs } from '../../src/backtest/clock.js';
import { ensureUser, expectNoHorizontalScroll, login, watchConsole, withDb } from './helpers.js';

/**
 * T12: the Backtest page on seeded historical data (`hist_games`, `markets`, `hist_prices` in the shared e2e
 * database): run an exact backtest from the form (tiles, equity / drawdown / monthly charts, trades table), save
 * it, run a second one with a different `atMinute` in modelled mode (badge), compare the two saved runs (two
 * equity lines), and start the Strategies page "Test against last 30 days". No legend on the page says "Live"
 * or "Dry run".
 */

let cspProblems: string[] = [];
test.beforeEach(({ context }) => {
  cspProblems = watchConsole(context);
});
test.afterEach(() => {
  expect(cspProblems, 'console messages about the Content Security Policy').toEqual([]);
});

const DAY = 24 * 60 * 60 * 1000;

/** 40 EPL games in 2025-26 (every other one with a lead at 75' and 80') plus 6 games in the last 30 days. */
function seedHistory(): void {
  const games: { id: string; season: string; playedAt: string; goals: { side: string; minute: number }[] }[] =
    [];
  const t0 = Date.parse('2025-08-16T14:00:00.000Z');
  for (let i = 0; i < 40; i++) {
    const side = i % 4 < 2 ? 'home' : 'away';
    const other = side === 'home' ? 'away' : 'home';
    const goals =
      i % 2 === 0
        ? [
            { side, minute: 20 + (i % 10) },
            { side, minute: 60 + (i % 10) },
            ...(i % 6 === 0
              ? [
                  { side: other, minute: 86 },
                  { side: other, minute: 89 },
                ]
              : []),
          ]
        : [
            { side, minute: 30 },
            { side: other, minute: 40 },
          ];
    games.push({
      id: `E2EBT-${i}`,
      season: '2025-26',
      playedAt: new Date(t0 + i * 3.5 * DAY).toISOString(),
      goals,
    });
  }
  for (let i = 0; i < 6; i++) {
    const at = new Date(Math.floor((Date.now() - (i + 2) * 4 * DAY) / 60_000) * 60_000).toISOString();
    games.push({
      id: `E2EBT-R${i}`,
      season: '2026-27',
      playedAt: at,
      goals: [
        { side: 'home', minute: 10 },
        { side: 'home', minute: 50 },
      ],
    });
  }
  withDb((db) => {
    const game = db.prepare(
      `INSERT OR IGNORE INTO games (id, league_id, scheduled_at, phase, updated_at) VALUES (?, 'epl', ?, 'finished', ?)`,
    );
    const market = db.prepare(
      `INSERT OR IGNORE INTO markets (ticker, game_id, outcome, status, updated_at) VALUES (?, ?, ?, 'finalized', ?)`,
    );
    const hist = db.prepare(
      `INSERT OR IGNORE INTO hist_games (id, league_id, season, played_at, home, away, final_home, final_away, goal_events, source, kalshi_event_ticker)
       VALUES (?, 'epl', ?, ?, ?, ?, ?, ?, ?, 'csv', ?)`,
    );
    const candle = db.prepare(
      `INSERT OR IGNORE INTO hist_prices (market_ticker, minute_ts, ask_close_bp, bid_close_bp, trade_close_bp, volume_cc) VALUES (?, ?, ?, ?, NULL, 0)`,
    );
    db.transaction(() => {
      for (const g of games) {
        const event = `KXEPLGAME-${g.id}`;
        game.run(event, g.playedAt, g.playedAt);
        market.run(`${event}-H`, event, 'home', g.playedAt);
        market.run(`${event}-A`, event, 'away', g.playedAt);
        const home = g.goals.filter((x) => x.side === 'home').length;
        const away = g.goals.filter((x) => x.side === 'away').length;
        hist.run(
          g.id,
          g.season,
          g.playedAt,
          `Home ${g.id}`,
          `Away ${g.id}`,
          home,
          away,
          JSON.stringify(g.goals.map((x) => ({ ...x, period: x.minute > 45 ? 2 : 1, second: 0 }))),
          event,
        );
        for (const ticker of [`${event}-H`, `${event}-A`]) {
          for (let m = 70; m <= 90; m++) {
            const ask = 9000 + ((m + g.id.length) % 6) * 100;
            candle.run(
              ticker,
              new Date(candleMinuteMs('soccer', Date.parse(g.playedAt), m)).toISOString(),
              ask,
              ask - 200,
            );
          }
        }
      }
    })();
  });
}

async function runFromForm(page: Page, atMinute: string, priceMode: 'Exact' | 'Modelled'): Promise<void> {
  const form = page.getByRole('form', { name: 'Run a backtest' });
  await form.getByLabel('League').selectOption('epl');
  await form.getByLabel('Strategy').selectOption('');
  await form.getByLabel(/^2025-26/).check();
  await form.getByLabel(new RegExp(`^${priceMode}`)).check();
  await form.getByLabel('Min lead (goals)').fill('2');
  await form.getByLabel('At minute').fill(atMinute);
  const before = page.url();
  await form.getByRole('button', { name: 'Run backtest' }).click();
  await expect(page).toHaveURL(/\/backtest\?run=/);
  await expect(page).not.toHaveURL(before);
  await expect(page.getByTestId('backtest-run')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

async function save(page: Page, name: string): Promise<void> {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save backtest' }).click();
  await expect(page.getByTestId('saved-backtests').getByRole('button', { name })).toBeVisible();
}

async function noLiveOrDryRunLegend(page: Page): Promise<void> {
  const legends = await page.locator('.recharts-legend-wrapper').allTextContents();
  expect(legends.length).toBeGreaterThan(0);
  for (const text of legends) {
    expect(text).not.toMatch(/\bLive\b/);
    expect(text).not.toMatch(/Dry run/i);
  }
  await expect(page.locator('main .mode-badge')).toHaveCount(0);
}

test('Backtest: run from the form, tiles + equity/drawdown/monthly charts + trades table; save; modelled second run with badge; compare two equity lines; quick 30-day test', async ({
  page,
}, info) => {
  seedHistory();
  await ensureUser(page);
  await login(page);
  await page.getByRole('link', { name: 'Backtest' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Backtest' })).toBeVisible();

  // 1. Exact run at 80'.
  await runFromForm(page, '80', 'Exact');
  const tiles = page.getByTestId('backtest-tiles');
  await expect(tiles).toBeVisible();
  await expect(page.getByTestId('bt-tile-trades').locator('.stat-number')).not.toHaveText('0');
  for (const id of ['equity', 'drawdown', 'monthly']) {
    await expect(page.getByTestId(`bt-chart-${id}`).locator('.recharts-wrapper')).toHaveCount(1);
  }
  await expect(page.getByTestId('backtest-trades').locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('backtest-trades')).toContainText('candle');
  await expect(page.getByTestId('modelled-badge')).toHaveCount(0);
  await noLiveOrDryRunLegend(page);
  const first = `E2E exact 80 ${info.project.name}`;
  await save(page, first);
  await expectNoHorizontalScroll(page);

  // 2. Modelled run at 75': the badge names the smallest sample size.
  await runFromForm(page, '75', 'Modelled');
  await expect(page.getByTestId('modelled-badge')).toBeVisible();
  await expect(page.getByTestId('modelled-badge')).toContainText('smallest sample size 0');
  await expect(page.getByTestId('backtest-trades')).toContainText('model');
  const second = `E2E modelled 75 ${info.project.name}`;
  await save(page, second);

  // 3. Compare the two saved runs.
  const saved = page.getByTestId('saved-backtests');
  await saved.getByRole('checkbox', { name: `Compare ${first}` }).check();
  await saved.getByRole('checkbox', { name: `Compare ${second}` }).check();
  const compare = page.getByTestId('bt-chart-compare');
  await expect(compare.locator('.recharts-line')).toHaveCount(2);
  await expect(compare.locator('.recharts-legend-wrapper')).toContainText(first);
  await expect(compare.locator('.recharts-legend-wrapper')).toContainText(second);
  await noLiveOrDryRunLegend(page);
  await expectNoHorizontalScroll(page);

  // 4. Strategies → "Test against last 30 days" → a quick exact backtest on the Backtest page.
  const name = `E2E backtest strategy ${info.project.name}`;
  const created = await page.evaluate(async (strategyName) => {
    const { token } = (await (await fetch('/api/csrf')).json()) as { token: string };
    const res = await fetch('/api/strategies', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({
        name: strategyName,
        sport: 'soccer',
        leagueIds: ['epl'],
        rule: { type: 'lead_at_time', minLead: 2, atMinute: 80, windowMinutes: 5 },
        sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
        execution: { maxPrice: 0.97 },
      }),
    });
    return res.status;
  }, name);
  expect(created).toBe(201);
  await page.getByRole('link', { name: 'Strategies' }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Test against last 30 days' }).click();
  await expect(page).toHaveURL(/\/backtest\?run=/);
  await expect(page.getByTestId('backtest-run')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(page.getByTestId('backtest-run')).toContainText(`${name} v1`);
  await expect(page.getByTestId('bt-tile-trades').locator('.stat-number')).toHaveText('6');
  await noLiveOrDryRunLegend(page);
});
