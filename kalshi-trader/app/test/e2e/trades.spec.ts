/// <reference lib="dom" />
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  ageAuthentication,
  ensureUser,
  expectNoHorizontalScroll,
  login,
  PASSWORD,
  watchConsole,
  withDb,
} from './helpers.js';

let cspProblems: string[] = [];
test.beforeEach(({ context }) => {
  cspProblems = watchConsole(context);
});
test.afterEach(() => {
  expect(cspProblems, 'console messages about the Content Security Policy').toEqual([]);
});

const GAME = 'KXNHLGAME-26OCT14SEAVGK';
const SERVER = `http://127.0.0.1:${Number(process.env['E2E_PORT'] ?? 8198)}`;

/** A hockey strategy on NHL (kill switch off) matching the replay at minute 55 (home leads 2-1). */
function addStrategy(name: string, mode: 'dry_run' | 'live'): string {
  const id = randomUUID();
  const at = new Date().toISOString();
  withDb((db) => {
    db.prepare(
      `INSERT INTO strategies (id, name, sport, mode, kill_switch, current_version, created_at, updated_at)
       VALUES (?, ?, 'hockey', ?, 0, 1, ?, ?)`,
    ).run(id, name, mode, at, at);
    db.prepare(
      `INSERT INTO strategy_versions (strategy_id, version, league_ids, rule, sizing, execution, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      JSON.stringify(['nhl']),
      JSON.stringify({
        type: 'lead_at_time',
        version: 1,
        minLead: 1,
        atMinute: 55,
        windowMinutes: 5,
        leaderSide: 'any',
      }),
      JSON.stringify({ type: 'percent_of_balance', percent: 2, minStakeUsd: 1, maxStakeUsd: 50 }),
      JSON.stringify({
        orderType: 'ioc_limit',
        maxPrice: 0.97,
        minPrice: null,
        maxSlippage: 0.01,
        minDepthContracts: 20,
        maxFeedAgeSec: 15,
      }),
      at,
    );
  });
  return id;
}

const tradeOf = (strategyId: string) =>
  withDb(
    (db) =>
      db.prepare('SELECT * FROM trades WHERE strategy_id = ? AND game_id = ?').get(strategyId, GAME) as
        | { id: string; status: string; effective_mode: string; configured_mode: string; mode_reason: string }
        | undefined,
  );

async function runReplay(): Promise<void> {
  const replay = spawn(
    'npx',
    [
      'tsx',
      'scripts/replay.ts',
      '--file',
      'test/fixtures/replay/nhl-sample.jsonl',
      '--speed',
      '100',
      '--url',
      SERVER,
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  replay.stdout.on('data', (d: Buffer) => (output += d.toString()));
  replay.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const code = await new Promise<number | null>((r) => replay.on('exit', r));
  expect(code, output).toBe(0);
}

async function confirmPassword(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm your password' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

test('Trades: a replayed dry-run trade shows its badge, snapshot and attempts; CSV has the mode columns; bankroll reset needs re-auth', async ({
  page,
}, info) => {
  await ensureUser(page);
  const dryId = addStrategy(`NHL trades e2e ${info.project.name}`, 'dry_run');
  const liveId = addStrategy(`NHL trades e2e live ${info.project.name}`, 'live');
  await login(page);

  await runReplay();
  await expect.poll(() => tradeOf(dryId)?.status, { timeout: 30_000 }).toBe('filled');
  await expect.poll(() => tradeOf(liveId)?.status, { timeout: 30_000 }).toBe('filled');
  const dry = tradeOf(dryId);
  const live = tradeOf(liveId);
  expect(dry).toMatchObject({
    effective_mode: 'dry_run',
    configured_mode: 'dry_run',
    mode_reason: 'addon_lock',
  });
  expect(live).toMatchObject({
    effective_mode: 'dry_run',
    configured_mode: 'live',
    mode_reason: 'addon_lock',
  });
  const dryTrade = dry?.id ?? '';
  const liveTrade = live?.id ?? '';

  await page.getByRole('link', { name: 'Trades' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trades' })).toBeVisible();
  const row = page.getByTestId(`trade-row-${dryTrade}`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`mode-${dryTrade}`)).toHaveText('DRY RUN');
  await expect(page.getByTestId(`mode-${liveTrade}`)).toHaveText('LIVE → DRY RUN (add-on lock)');
  await expect(page.getByTestId(`status-${dryTrade}`)).toHaveText('Filled');

  // Expand: the trigger snapshot (score, minute, minute source, feed timestamps) and the attempts list.
  await row.getByRole('button', { expanded: false }).click();
  const snapshot = page.getByTestId(`snapshot-${dryTrade}`);
  await expect(snapshot).toContainText('2–1');
  await expect(snapshot).toContainText('Minute55');
  await expect(snapshot).toContainText('Minute sourcefeed');
  await expect(snapshot).toContainText('Observed');
  await expect(snapshot).toContainText('Feed timestamp');
  await expect(snapshot).toContainText('Ask at trigger$0.93');
  const attempts = page.getByTestId(`attempts-${dryTrade}`);
  await expect(attempts.locator('tbody tr')).toHaveCount(1);
  await expect(attempts.locator('tbody tr').first()).toContainText('filled 2 @ $0.94');
  await expect(page.getByTestId(`audit-${dryTrade}`)).toContainText('trade_filled');
  await expectNoHorizontalScroll(page);

  // CSV: a header with the four mode columns and one line per visible trade.
  const visible = await page.locator('[data-testid^="trade-row-"]').count();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await (await download).path();
  const lines = readFileSync(file, 'utf8').trimEnd().split('\r\n');
  expect(lines[0]).toContain('effective_mode,configured_mode,mode_reason,kalshi_env');
  expect(lines).toHaveLength(visible + 1);
  expect(
    lines.some((l) => l.startsWith(`${dryTrade},`) && l.includes(',dry_run,dry_run,addon_lock,demo,')),
  ).toBe(true);
  expect(
    lines.some((l) => l.startsWith(`${liveTrade},`) && l.includes(',dry_run,live,addon_lock,demo,')),
  ).toBe(true);

  // Settings → Trading: resetting the dry-run bankroll needs the password.
  const bankroll = () =>
    withDb((db) => {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'dry_run_bankroll_micros'").get() as
        { value: string } | undefined;
      return row ? Number(row.value) : 100_000_000;
    });
  expect(bankroll()).toBeLessThan(100_000_000);
  const resetsBefore = withDb(
    (db) =>
      (
        db.prepare("SELECT count(*) AS n FROM bankroll_snapshots WHERE reason = 'reset'").get() as {
          n: number;
        }
      ).n,
  );
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Trading' }).click();
  await expect(page.getByRole('heading', { name: 'Dry-run bankroll' })).toBeVisible();
  ageAuthentication();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Reset bankroll' }).click();
  await confirmPassword(page);
  await expect(page.getByText('Bankroll reset.')).toBeVisible();
  await expect(page.getByTestId('bankroll-current')).toHaveText('$100.00');
  expect(bankroll()).toBe(100_000_000);
  const reset = withDb((db) => ({
    snapshots: (
      db
        .prepare(
          "SELECT count(*) AS n FROM bankroll_snapshots WHERE reason = 'reset' AND bankroll_micros = 100000000",
        )
        .get() as {
        n: number;
      }
    ).n,
    audit: db
      .prepare("SELECT mode FROM audit_log WHERE action = 'dry_run_bankroll_reset' ORDER BY id DESC LIMIT 1")
      .get() as { mode: string } | undefined,
  }));
  expect(reset.snapshots).toBe(resetsBefore + 1);
  expect(reset.audit).toEqual({ mode: 'dry_run' });
  await expectNoHorizontalScroll(page);

  // Leave the strategies paused for later runs.
  withDb((db) => db.prepare('UPDATE strategies SET kill_switch = 1 WHERE id IN (?, ?)').run(dryId, liveId));
});
