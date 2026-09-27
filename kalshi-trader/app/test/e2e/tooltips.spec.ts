/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { ensureUser, login, watchConsole } from './helpers.js';

let cspProblems: string[] = [];
test.beforeEach(({ context }) => {
  cspProblems = watchConsole(context);
});
test.afterEach(() => {
  expect(cspProblems, 'console messages about the Content Security Policy').toEqual([]);
});

test('ⓘ explanations: shown on hover, focus and tap; hidden again on leave, Escape and a second tap', async ({
  page,
}) => {
  await ensureUser(page);
  await login(page);
  await page.goto('/settings/trading');
  const kill = page.locator('.switch-card.kill');
  const info = kill.getByRole('button', { name: 'More information' });
  const tip = page.getByRole('tooltip');

  // The explanation is not in the page until asked for.
  await expect(tip).toHaveCount(0);
  await expect(kill).not.toContainText('emergency stop');

  await info.hover();
  await expect(tip).toContainText('emergency stop');
  await expect(info).toHaveAttribute('aria-describedby', (await tip.getAttribute('id')) ?? '');
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);

  await info.focus();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);

  // A click (tap) pins it open; a second one closes it. The bubble stays inside the viewport.
  await info.click();
  await expect(tip).toBeVisible();
  const box = await tip.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
  await info.click();
  await expect(tip).toHaveCount(0);
});
