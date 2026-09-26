/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import {
  ageAuthentication,
  auditActions,
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

const strategyRow = (name: string) =>
  withDb(
    (db) =>
      db.prepare('SELECT id, kill_switch, mode, current_version FROM strategies WHERE name = ?').get(name) as
        { id: string; kill_switch: number; mode: string; current_version: number } | undefined,
  );

/** Answers the step-up prompt, which must appear. */
async function confirmPassword(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm your password' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

test('Strategies: create (inline error first), kill switch off with password, edit → two versions, live → re-auth and "LIVE → DRY RUN (add-on lock)"', async ({
  page,
}, info) => {
  const name = `EPL lead e2e ${info.project.name}`;
  await ensureUser(page);
  await login(page);
  await page.getByRole('link', { name: 'Strategies' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Strategies' })).toBeVisible();

  // Create: an invalid percent shows an inline error first and nothing is saved.
  await page.getByRole('button', { name: 'New strategy' }).click();
  const drawer = page.getByRole('dialog', { name: 'New strategy' });
  await drawer.getByLabel('Name').fill(name);
  await drawer.getByLabel('English Premier League').check();
  await drawer.getByLabel('Stake (% of balance)').fill('150');
  await drawer.getByRole('button', { name: 'Create strategy' }).click();
  const percentError = drawer.locator('[data-field="sizing.percent"]');
  await expect(percentError).toBeVisible();
  await expect(percentError).toContainText('percent must be at most 100');
  await expect(drawer.getByLabel('Stake (% of balance)')).toHaveAttribute('aria-invalid', 'true');
  expect(strategyRow(name)).toBeUndefined();
  await expect(
    drawer.getByRole('button', { name: 'Test against last 30 days' }),
    'backtest button present but disabled',
  ).toBeDisabled();
  await expect(drawer.locator('[title="available after backtesting (T12)"]')).toHaveCount(1);

  await drawer.getByLabel('Stake (% of balance)').fill('2');
  await expect(percentError).toBeHidden();
  await drawer.getByRole('button', { name: 'Create strategy' }).click();
  await expect(drawer).toBeHidden();
  const created = strategyRow(name);
  expect(created).toMatchObject({ kill_switch: 1, mode: 'dry_run', current_version: 1 });
  const id = created?.id ?? '';
  const badge = page.getByTestId(`effective-${id}`);
  await expect(badge).toHaveText('PAUSED');

  // Kill switch off → password prompt (the sign-in is aged past the 5-minute step-up window).
  ageAuthentication();
  const kill = page.getByRole('switch', { name: `Kill switch: ${name}` });
  await expect(kill).toBeChecked();
  await kill.click();
  await confirmPassword(page);
  await expect(kill).not.toBeChecked();
  await expect(badge).toHaveText('DRY RUN');
  expect(strategyRow(name)?.kill_switch).toBe(0);

  // Edit → version 2, both versions listed.
  await page.getByRole('button', { name, exact: true }).click();
  const editor = page.getByRole('dialog', { name: `Edit “${name}”` });
  await expect(editor.getByLabel('Minimum lead (goals)')).toHaveValue('2');
  await editor.getByLabel('Minimum lead (goals)').fill('3');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('version-history').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('version-2')).toContainText('lead ≥ 3');
  await expect(page.getByTestId('version-1')).toContainText('lead ≥ 2');
  expect(strategyRow(name)?.current_version).toBe(2);
  await expectNoHorizontalScroll(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // Mode → live: re-auth prompt, then the badge shows the add-on lock downgrade.
  ageAuthentication();
  const live = page.getByRole('switch', { name: `Live mode: ${name}` });
  await live.click();
  await confirmPassword(page);
  await expect(live).toBeChecked();
  await expect(badge).toHaveText('LIVE → DRY RUN (add-on lock)');
  expect(strategyRow(name)).toMatchObject({ mode: 'live', kill_switch: 0, current_version: 2 });
  expect(auditActions()).toEqual(
    expect.arrayContaining([
      'strategy_created',
      'strategy_kill_switch_changed',
      'strategy_edited',
      'strategy_mode_changed',
    ]),
  );

  // Back to safety for the next run (no prompt needed).
  await live.click();
  await expect(page.getByRole('dialog', { name: 'Confirm your password' })).toBeHidden();
  await expect(badge).toHaveText('DRY RUN');
  await page.getByRole('switch', { name: `Kill switch: ${name}` }).click();
  await expect(badge).toHaveText('PAUSED');
  await expectNoHorizontalScroll(page);
});
