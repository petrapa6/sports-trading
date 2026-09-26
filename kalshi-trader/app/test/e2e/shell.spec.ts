/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { generateSync } from 'otplib';
import {
  ageAuthentication,
  auditActions,
  DB_PATH,
  ensureUser,
  expectNoHorizontalScroll,
  INGRESS_PATH,
  login,
  logout,
  NAV,
  PASSWORD,
  PROXY,
  USER,
  watchConsole,
} from './helpers.js';

const VERSION = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }
).version;

let cspProblems: string[] = [];
test.beforeEach(({ context }) => {
  cspProblems = watchConsole(context);
});
test.afterEach(() => {
  expect(cspProblems, 'console messages about the Content Security Policy').toEqual([]);
});

/** Clicks every main navigation item and checks its heading (and that nothing scrolls sideways). */
async function visitAllPages(page: Page) {
  await expectNoHorizontalScroll(page);
  for (const item of NAV) {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: item, exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: item })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  for (const section of ['Account', 'Diagnostics', 'Trading']) {
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: section })
      .click();
    await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
}

test('setup → login → Dashboard → every page → logout', async ({ page }) => {
  await ensureUser(page); // first run: via the ingress proxy, like the Home Assistant sidebar
  await page.context().clearCookies();

  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/login$/);
  await expectNoHorizontalScroll(page);
  await login(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('live-status')).toContainText(/connected/);
  await visitAllPages(page);
  await logout(page);
  // Signed out: the app pages send the browser back to the login page.
  await page.goto('/settings/trading');
  await expect(page).toHaveURL(/\/login$/);
});

test('filter bar state lives in the URL: select, reload, back', async ({ page }) => {
  await ensureUser(page);
  await login(page);
  await expect(page.getByRole('radio', { name: 'Both' })).toBeChecked(); // default mode
  expect(new URL(page.url()).search).toBe('');

  await page.getByRole('checkbox', { name: 'English Premier League' }).check();
  await page.getByRole('radio', { name: 'Live', exact: true }).check();
  await expect(page).toHaveURL(/\?leagues=epl&mode=live$/);
  await page.getByRole('radio', { name: '30d' }).check();
  await expect(page).toHaveURL(/\/\?leagues=epl&mode=live&range=30d$/);
  expect(new URL(page.url()).search).toBe('?leagues=epl&mode=live&range=30d');

  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'English Premier League' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Live', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: '30d' })).toBeChecked();

  await page.goBack();
  await expect(page).toHaveURL(/\/\?leagues=epl&mode=live$/);
  await expect(page.getByRole('radio', { name: 'All', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Live', exact: true })).toBeChecked();
  await page.goBack();
  await expect(page).toHaveURL(/\/\?leagues=epl$/);
  await expect(page.getByRole('radio', { name: 'Both' })).toBeChecked();
  await expectNoHorizontalScroll(page);
});

test('switches: on needs no prompt; off without recent re-auth asks for the password', async ({ page }) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/trading');
  const kill = page.getByRole('switch', { name: 'Global kill switch' });
  const dryRun = page.getByRole('switch', { name: 'Global dry run' });
  await expect(kill).not.toBeChecked();
  await expect(dryRun).toBeChecked();

  // allow_live_orders is shown locked and read-only.
  const lock = page.getByTestId('allow-live-orders');
  await expect(lock).toContainText('allow_live_orders: false');
  await expect(lock).toContainText('read-only');
  await expect(lock).toHaveAttribute('aria-readonly', 'true');
  await expect(lock.locator('input')).toHaveCount(0);

  // Order group (T13): unused while live orders are locked; its reset is disabled.
  await expect(page.getByRole('heading', { name: 'Order group' })).toBeVisible();
  await expect(page.getByTestId('order-group-state')).toContainText('live orders are disabled');
  await expect(page.getByRole('button', { name: 'Reset order group' })).toBeDisabled();

  ageAuthentication(); // the login is no longer a recent authentication

  // Kill switch ON: no prompt; persists; audited.
  await kill.click();
  await expect(kill).toBeChecked();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(kill).toBeChecked();
  expect(auditActions()).toContain('global_kill_switch_on');

  // Kill switch OFF: the password prompt opens; cancelling changes nothing.
  await kill.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm your password' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(kill).toBeChecked();
  await kill.click();
  await dialog.getByLabel('Password').fill('not the password');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Wrong password.');
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(kill).not.toBeChecked();
  expect(auditActions()).toContain('global_kill_switch_off');

  // Global dry run OFF needs step-up too; ON does not.
  ageAuthentication();
  await dryRun.click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dryRun).not.toBeChecked();
  expect(auditActions()).toContain('global_dry_run_off');
  ageAuthentication();
  await dryRun.click();
  await expect(dryRun).toBeChecked();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(dryRun).toBeChecked();
  expect(auditActions()).toContain('global_dry_run_on');
  await expectNoHorizontalScroll(page);
});

test('account: change password, TOTP enrol/disable, revoke another session', async ({ page, browser }) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/account');
  const NEW = 'e2e changed password 2';

  // Wrong current password → inline error.
  await page.getByLabel('Current password').fill('definitely wrong');
  await page.getByLabel('New password (at least 12 characters)').fill(NEW);
  await page.getByLabel('Repeat the new password').fill(NEW);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert')).toHaveText('The current password is wrong.');

  // Correct → success; the old password no longer works.
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible();
  await logout(page);
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');
  await login(page, NEW);

  // Change it back so the other specs keep working.
  await page.goto('/settings/account');
  await page.getByLabel('Current password').fill(NEW);
  await page.getByLabel('New password (at least 12 characters)').fill(PASSWORD);
  await page.getByLabel('Repeat the new password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible();

  // TOTP: QR image + secret; a code generated from the secret enables it.
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  const qr = page.getByAltText('TOTP QR code');
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(await qr.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const secret = (await page.getByTestId('totp-secret').textContent()) ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await page.getByLabel('Code from the app').fill(generateSync({ secret }));
  await page.getByRole('button', { name: 'Enable two-factor' }).click();
  await expect(page.getByTestId('totp-status')).toHaveText('enabled');
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Disable two-factor' }).click();
  await expect(page.getByTestId('totp-status')).toHaveText('off');

  // A second browser signs in; revoking its session logs it out on its next request.
  const second = await browser.newContext({ userAgent: 'E2E-Second-Browser' });
  const cspSecond = watchConsole(second);
  try {
    const other = await second.newPage();
    await login(other);
    await page.reload();
    const row = page.getByRole('row').filter({ hasText: 'E2E-Second-Browser' });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'E2E-Second-Browser' })).toHaveCount(0);
    await other.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
    await expect(other).toHaveURL(/\/login$/);
    await other.goto('/trades');
    await expect(other).toHaveURL(/\/login$/);
    expect(cspSecond).toEqual([]);
  } finally {
    await second.close();
  }
});

test('diagnostics: version, DB path and size, live log tail with mode filter', async ({ page }) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/diagnostics');
  await expect(page.getByTestId('app-version')).toHaveText(VERSION);
  await expect(page.getByTestId('db-path')).toHaveText(DB_PATH);
  await expect(page.getByTestId('db-size')).toHaveText(/^\d+\.\d{2} MB$/);
  const tail = page.getByTestId('log-tail');
  await expect(tail.locator('li[data-mode="none"]').first()).toBeVisible(); // start-up lines carry mode null

  // A switch change elsewhere (another tab) shows up without a reload.
  const post = (body: unknown, url = 'api/settings') =>
    page.evaluate(
      async ({ body, url }) => {
        const { token } = (await (await fetch('api/csrf')).json()) as { token: string };
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': token },
          body: JSON.stringify(body),
        });
        return res.status;
      },
      { body, url },
    );
  expect(await post({ global_kill_switch: true })).toBe(200);
  await expect(tail.getByText('Global kill switch turned on').last()).toBeVisible();
  ageAuthentication();
  expect(await post({ global_kill_switch: false })).toBe(403); // step-up is enforced server-side too
  expect(await post({ password: PASSWORD }, 'auth/reauth')).toBe(200);
  expect(await post({ global_kill_switch: false })).toBe(200);
  await expect(tail.getByText('Global kill switch turned off').last()).toBeVisible();

  // Mode filter dry_run hides every line whose mode is not dry_run.
  const all = await tail.locator('li.log-line').count();
  await page.getByLabel('Mode').selectOption('dry_run');
  const shown = tail.locator('li.log-line');
  await expect(shown.first()).toBeVisible();
  expect(await shown.count()).toBeLessThan(all);
  const modes = await shown.evaluateAll((els) => els.map((e) => e.getAttribute('data-mode')));
  expect(modes.length).toBeGreaterThan(0);
  expect(new Set(modes)).toEqual(new Set(['dry_run']));
  await expect(shown.first().locator('.mode-badge')).toHaveText('DRY RUN');
  await expectNoHorizontalScroll(page);
});

test('ingress: prefixed <base href> and assets; every page works under the ingress path', async ({
  page,
}) => {
  await ensureUser(page);
  const notFound: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 404) notFound.push(r.url());
  });
  const res = await page.goto(`${PROXY}${INGRESS_PATH}/login`);
  expect(res?.headers()['x-frame-options']).toBe('SAMEORIGIN');
  const html = (await res?.text()) ?? '';
  expect(html).toContain(`<base href="${INGRESS_PATH}/">`);
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1] ?? '')
    .filter((u) => !u.startsWith('data:'));
  expect(urls.length).toBeGreaterThan(0);
  for (const u of urls) expect(u.startsWith(`${INGRESS_PATH}/`), u).toBe(true);

  await login(page, PASSWORD, `${PROXY}${INGRESS_PATH}`);
  await expect(page).toHaveURL(`${PROXY}${INGRESS_PATH}/`);
  await expect(page.getByTestId('live-status')).toContainText(/connected/);
  await visitAllPages(page);
  await expect(page).toHaveURL(`${PROXY}${INGRESS_PATH}/settings/trading`);
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Trading' })).toBeVisible();
  await logout(page);
  await expect(page).toHaveURL(`${PROXY}${INGRESS_PATH}/login`);
  expect(notFound).toEqual([]);
});
