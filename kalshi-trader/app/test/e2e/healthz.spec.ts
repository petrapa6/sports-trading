import { expect, test } from '@playwright/test';

test('GET /healthz returns {"ok":true,"loop":…} without console or CSP errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    // The browser's automatic favicon request is not part of the page under test.
    if (msg.location().url.endsWith('/favicon.ico')) return;
    if (msg.type() === 'error' || /content security policy/i.test(msg.text())) problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(err.message));

  const response = await page.goto('/healthz');
  expect(response?.status()).toBe(200);
  // Since T07 the body carries the trading loop state as well.
  expect(await response?.text()).toMatch(/^\{"ok":true,"loop":"(starting|idle|running)"\}$/);
  expect(problems).toEqual([]);
});
