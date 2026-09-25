import { existsSync } from 'node:fs';
import { chromium, defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 8198);

/**
 * Prefer Playwright's own Chromium; when it is not installed but a system/pre-installed
 * Chromium is available (e.g. a sandbox with /opt/pw-browsers/chromium), use that instead.
 */
function chromiumExecutable(): string | undefined {
  const override = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  if (override) return override;
  if (existsSync(chromium.executablePath())) return undefined;
  for (const candidate of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const executablePath = chromiumExecutable();

export default defineConfig({
  testDir: 'test/e2e',
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'tsx src/server/main.ts',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      LOG_LEVEL: 'warn',
      CONFIG_LOCAL_PATH: '/nonexistent/config.local.json',
    },
  },
});
