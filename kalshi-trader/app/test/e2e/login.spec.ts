import { expect, test } from '@playwright/test';

test('unauthenticated navigation lands on the login page without console or CSP errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.location().url.endsWith('/favicon.ico')) return;
    // The failed sign-in below answers 401 by design; the browser logs that as a resource error.
    if (/status of 401/.test(msg.text())) return;
    if (msg.type() === 'error' || /content security policy/i.test(msg.text())) problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(err.message));

  const response = await page.goto('/');
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  await expect(page.getByRole('heading', { name: 'Kalshi Sports Trader' })).toBeVisible();

  // The stylesheet is served from /assets and applied (no inline styles under the CSP).
  await expect(page.locator('main')).toHaveCSS('border-radius', '12px');

  await page.getByLabel('Username').fill('nobody');
  await page.getByLabel('Password').fill('wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');
  expect(problems).toEqual([]);
});

test('API routes answer 401 JSON without a session', async ({ request }) => {
  const res = await request.get('/api/anything');
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
});
