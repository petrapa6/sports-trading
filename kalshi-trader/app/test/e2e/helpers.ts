/// <reference lib="dom" />
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, type BrowserContext, type Page } from '@playwright/test';

export const USER = 'pavel';
export const PASSWORD = 'e2e long password 1';
export const PROXY = `http://127.0.0.1:${Number(process.env['E2E_PROXY_PORT'] ?? 8199)}`;
export const INGRESS_PATH = '/api/hassio_ingress/abc';
export const DB_PATH = resolve(import.meta.dirname, '../../.local/e2e/trader.db');

export const NAV = ['Dashboard', 'Strategies', 'Trades', 'Backtest', 'Settings'] as const;

/**
 * Collects every console message about the Content Security Policy (and page errors) in a
 * context; the suite asserts the list stays empty.
 */
export function watchConsole(context: BrowserContext): string[] {
  const problems: string[] = [];
  const attach = (page: Page) => {
    page.on('console', (msg) => {
      if (/content security policy/i.test(msg.text())) problems.push(`CSP: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  };
  context.pages().forEach(attach);
  context.on('page', attach);
  return problems;
}

/** `document.documentElement.scrollWidth` must not exceed the viewport (no sideways scrolling). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `scrollWidth on ${page.url()}`).toBeLessThanOrEqual(width);
}

/** Signs in through the login page (at `base`, the root or the ingress prefix) and waits for the Dashboard. */
export async function login(page: Page, password = PASSWORD, base = ''): Promise<void> {
  await page.goto(`${base}/login`);
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
}

/** Runs SQL against the e2e database (WAL: safe next to the running server). */
export function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Makes every session's last authentication 10 minutes old, so the next step-up check fails. */
export function ageAuthentication(): void {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  withDb((db) => db.prepare('UPDATE sessions SET last_auth_at = ?').run(old));
}

export function auditActions(): string[] {
  return withDb((db) =>
    (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
      (r) => r.action,
    ),
  );
}

/** Creates the user through the ingress proxy (first-run setup) unless it exists already. */
export async function ensureUser(page: Page): Promise<void> {
  const state = (await (await page.request.get(`${PROXY}${INGRESS_PATH}/auth/state`)).json()) as {
    needsSetup: boolean;
  };
  if (!state.needsSetup) return;
  await page.goto(`${PROXY}${INGRESS_PATH}/`);
  await expect(page).toHaveURL(`${PROXY}${INGRESS_PATH}/setup`);
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password (at least 12 characters)').fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}
