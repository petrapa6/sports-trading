import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureUser, expectNoHorizontalScroll, login, watchConsole, withDb } from './helpers.js';

const SAMPLE_CSV = resolve(import.meta.dirname, '../fixtures/csv/sample.csv');

test('Settings → Data: the sample CSV shows "3 rows imported"; Rebuild price model shows per-sport sample sizes; DB size updates after vacuum', async ({
  page,
  context,
}) => {
  const problems = watchConsole(context);
  await ensureUser(page);
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Data' })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'Data' })).toBeVisible();
  await expect(page.getByTestId('data-db-size')).toContainText('bytes');

  await page.getByLabel('CSV file').setInputFiles(SAMPLE_CSV);
  await page.getByRole('button', { name: 'Import CSV' }).click();
  await expect(page.getByTestId('data-notice')).toContainText('3 rows imported');
  await expect(page.getByTestId('data-hist-games')).toContainText('csv 3');
  expect(
    withDb(
      (db) =>
        (db.prepare("SELECT count(*) AS n FROM hist_games WHERE source = 'csv'").get() as { n: number }).n,
    ),
  ).toBe(3);

  await page.getByRole('button', { name: 'Rebuild price model' }).click();
  await expect(page.getByTestId('price-model-soccer')).toContainText(/Sample size \d+/);
  await expect(page.getByTestId('price-model-hockey')).toContainText(/Sample size \d+/);

  const before = await page.getByTestId('data-db-size').textContent();
  await page.getByRole('button', { name: 'Vacuum database' }).click();
  await expect(page.getByTestId('vacuum-result')).toBeVisible();
  await expect(page.getByTestId('data-db-size')).not.toHaveText(before ?? '');

  await expectNoHorizontalScroll(page);
  expect(problems).toEqual([]);
});
