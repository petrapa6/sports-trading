import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers.js';

test('unauthenticated navigation lands on the login page; a wrong password shows the generic error', async ({
  page,
  context,
}) => {
  const problems = watchConsole(context);
  const response = await page.goto('/');
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  await expect(page.getByRole('heading', { name: 'Kalshi Sports Trader' })).toBeVisible();

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
