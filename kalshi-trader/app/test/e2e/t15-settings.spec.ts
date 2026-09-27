/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { ensureUser, expectNoHorizontalScroll, login, watchConsole, withDb } from './helpers.js';

/** T15 acceptance 8: Settings → Feeds (masked API-Football key, quota usage) and Settings → Notifications. */

let cspProblems: string[] = [];
test.beforeEach(({ context }) => {
  cspProblems = watchConsole(context);
});
test.afterEach(() => {
  expect(cspProblems, 'console messages about the Content Security Policy').toEqual([]);
});

// Built at runtime so no key-like literal is committed (gitleaks generic-api-key).
const KEY = 'w'.repeat(26);

const setting = (key: string): unknown =>
  withDb((db) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  });

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('Settings → Feeds: the API-Football key field is masked; quota usage is shown', async ({ page }) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/feeds');
  const panel = page.getByTestId('api-football-settings');
  await expect(panel.getByRole('heading', { name: 'API-Football' })).toBeVisible();
  await expect(page.getByTestId('feed-api-football')).toContainText(
    'unavailable (no API-Football key stored)',
  );

  const field = panel.getByLabel('API key');
  await expect(field).toHaveAttribute('type', 'password');
  await expect(page.getByTestId('api-football-key-state')).toContainText('not set');
  await expect(page.getByTestId('api-football-quota')).toContainText(/Requests today: \d+ \/ 100/);

  await field.fill(KEY);
  await panel.getByRole('button', { name: 'Save key' }).click();
  await expect(panel.getByText('API-Football key saved.')).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('placeholder', '••••••••••••');
  await expect(page.getByTestId('api-football-key-state')).toContainText('•••••••••••• (stored, encrypted)');
  const stored = setting('api_football_key_enc');
  expect(typeof stored).toBe('string');
  expect(stored).not.toContain(KEY);

  // Usage of the local day, read back after a reload; the key never reaches the page.
  withDb((db) =>
    db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('api_football_quota', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify({ day: today(), used: 17 }), new Date().toISOString()),
  );
  await page.reload();
  await expect(page.getByTestId('api-football-quota')).toContainText('Requests today: 17 / 100');
  await expect(page.getByTestId('feed-api-football')).not.toContainText('unavailable');
  expect(await page.content()).not.toContain(KEY);

  await panel.getByLabel('Daily request limit').fill('7500');
  await panel.getByRole('button', { name: 'Save limit' }).click();
  await expect(page.getByTestId('api-football-quota')).toContainText('Requests today: 17 / 7500');
  await expectNoHorizontalScroll(page);

  // Leave the shared database as it was (the other specs expect API-Football unavailable).
  page.once('dialog', (d) => void d.accept());
  await panel.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByTestId('api-football-key-state')).toContainText('not set');
  expect(setting('api_football_key_enc')).toBeNull();
  withDb((db) =>
    db.prepare("DELETE FROM settings WHERE key IN ('api_football_quota', 'api_football_daily_limit')").run(),
  );
});

test('Settings → Notifications: toggles persist', async ({ page }) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/notifications');
  await expect(page.getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
  await expect(page.getByTestId('notifications-unavailable')).toBeVisible();

  const settled = () => page.getByRole('switch', { name: 'Trade settled notifications' });
  const dry = () => page.getByRole('switch', { name: 'Dry-run trades and events notifications' });
  await expect(settled()).toBeChecked();
  await expect(dry()).toBeChecked();
  await settled().click();
  await expect(settled()).not.toBeChecked();
  await dry().click();
  await expect(dry()).not.toBeChecked();
  await page.reload();
  await expect(settled()).not.toBeChecked();
  await expect(dry()).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Trade filled notifications' })).toBeChecked();
  expect(setting('notifications')).toMatchObject({
    events: { trade_settled: false },
    modes: { live: true, dry_run: false },
  });

  await settled().click();
  await dry().click();
  await page.reload();
  await expect(settled()).toBeChecked();
  await expect(dry()).toBeChecked();
  await expectNoHorizontalScroll(page);
});
