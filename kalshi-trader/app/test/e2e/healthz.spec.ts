import { expect, test } from '@playwright/test';

test('GET /healthz returns {"ok":true} without console or CSP errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    // The browser's automatic favicon request is not part of the page under test.
    if (msg.location().url.endsWith('/favicon.ico')) return;
    if (msg.type() === 'error' || /content security policy/i.test(msg.text())) problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(err.message));

  const response = await page.goto('/healthz');
  expect(response?.status()).toBe(200);
  expect(await response?.text()).toBe('{"ok":true}');
  expect(problems).toEqual([]);
});
