import { existsSync } from 'node:fs';
import { chromium, defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 8198);
const PROXY_PORT = Number(process.env['E2E_PROXY_PORT'] ?? 8199);

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

/**
 * `npm run e2e` builds the web app first (`vite build`), then runs the specs against the production
 * server on :8198 (a fresh database in `.local/e2e`) and a local stand-in for the ingress proxy on
 * :8199. The specs share one user and database, so they run in one worker, in file order.
 */
export default defineConfig({
  testDir: 'test/e2e',
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: 'rm -rf .local/e2e && tsx src/server/main.ts',
      url: `http://127.0.0.1:${PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        PORT: String(PORT),
        LOG_LEVEL: 'info',
        CONFIG_LOCAL_PATH: '/nonexistent/config.local.json',
        DB_PATH: './.local/e2e/trader.db',
        DATA_DIR: './.local/e2e/data',
        KST_E2E: '1',
      },
    },
    {
      command: 'tsx test/e2e/ingress-proxy.ts',
      url: `http://127.0.0.1:${PROXY_PORT}/api/hassio_ingress/abc/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { E2E_PORT: String(PORT), E2E_PROXY_PORT: String(PROXY_PORT) },
    },
  ],
});
