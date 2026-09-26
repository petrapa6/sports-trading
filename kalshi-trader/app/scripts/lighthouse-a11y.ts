/**
 * `npm run lighthouse:a11y` (T14): Lighthouse's accessibility score for the Dashboard and the Trades page must be
 * at least 90, at desktop (1280 px) and mobile (390 px) widths.
 *
 * Runs the production build (`npm run build` first unless `--no-build`) on a scratch database seeded with
 * `seed:demo` (trades in both modes, so the tables and charts have content), signs in through first-run setup
 * (loopback is class `dev`, `NODE_ENV=development`), and runs Lighthouse against each page with the session cookie.
 * Lighthouse is not a project dependency (§4 keeps the dependency list short): the script runs a pinned version
 * with `npx --yes lighthouse@12.8.2`, using Playwright's (or the pre-installed) Chromium.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { APP, cleanEnv, run, sleep } from './verify-lib.js';

const LIGHTHOUSE = 'lighthouse@12.8.2';
const MIN_SCORE = 90;
const PORT = Number(process.env['LH_PORT'] ?? 8295);
const base = `http://127.0.0.1:${PORT}`;
const argv = process.argv.slice(2);

function chromePath(): string {
  const override = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  if (override) return override;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'])
    if (existsSync(c)) return c;
  throw new Error('no Chromium found (npx playwright install chromium)');
}

if (!argv.includes('--no-build')) {
  const b = run('npm', ['run', 'build']);
  if (b.code !== 0) {
    console.error(b.out.slice(-2000));
    process.exit(1);
  }
}

const scratch = join(APP, '.local/lighthouse');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const env = cleanEnv({
  NODE_ENV: 'development',
  PORT: String(PORT),
  DB_PATH: join(scratch, 'trader.db'),
  DATA_DIR: join(scratch, 'data'),
  LOG_LEVEL: 'warn',
});
const seeded = run('npx', ['tsx', 'scripts/seed-demo.ts', '--trades', '300'], { env });
if (seeded.code !== 0) {
  console.error(seeded.out);
  process.exit(1);
}
const server = spawn(process.execPath, ['dist/server/main.js'], {
  cwd: APP,
  env,
  stdio: 'ignore',
  detached: true,
});

let failed = false;
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try {
      await fetch(`${base}/healthz`);
      up = true;
    } catch {
      await sleep(200);
    }
  }
  if (!up) throw new Error(`the server did not answer on ${base}`);
  const setup = await fetch(`${base}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'lighthouse', password: 'lighthouse audit password' }),
  });
  if (setup.status !== 201) throw new Error(`setup → ${setup.status} ${await setup.text()}`);
  const cookie = setup.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const chrome = chromePath();

  for (const [name, path] of [
    ['Dashboard', '/'],
    ['Trades', '/trades'],
  ] as const) {
    for (const width of ['desktop', 'mobile'] as const) {
      const out = join(scratch, `${name.toLowerCase()}-${width}.json`);
      const r = run(
        'npx',
        [
          '--yes',
          LIGHTHOUSE,
          `${base}${path}`,
          '--only-categories=accessibility',
          '--output=json',
          `--output-path=${out}`,
          `--extra-headers=${JSON.stringify({ Cookie: cookie })}`,
          `--chrome-path=${chrome}`,
          '--chrome-flags=--headless=new --no-sandbox --disable-gpu',
          '--quiet',
          ...(width === 'desktop'
            ? ['--preset=desktop']
            : ['--form-factor=mobile', '--screenEmulation.width=390', '--screenEmulation.height=844']),
        ],
        { env: { ...process.env, CHROME_PATH: chrome } },
      );
      if (r.code !== 0 || !existsSync(out)) {
        failed = true;
        console.log(`FAIL ${name} (${width}): lighthouse exited ${r.code}: ${r.out.slice(-1500)}`);
        continue;
      }
      const report = JSON.parse(readFileSync(out, 'utf8')) as {
        finalDisplayedUrl: string;
        categories: { accessibility: { score: number | null } };
        audits: Record<string, { score: number | null; title: string; scoreDisplayMode: string }>;
      };
      const score = Math.round((report.categories.accessibility.score ?? 0) * 100);
      const failing = Object.entries(report.audits)
        .filter(([, a]) => a.scoreDisplayMode === 'binary' && a.score === 0)
        .map(([id]) => id);
      const landed = new URL(report.finalDisplayedUrl).pathname;
      const ok = score >= MIN_SCORE && landed === path;
      if (!ok) failed = true;
      console.log(
        `${ok ? 'PASS' : 'FAIL'} ${name} (${width}, ${landed}): accessibility ${score}${failing.length ? `; failing audits: ${failing.join(', ')}` : ''}`,
      );
    }
  }
} catch (err) {
  failed = true;
  console.log(`FAIL ${(err as Error).message}`);
} finally {
  if (server.pid !== undefined)
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // already gone
    }
}
process.exit(failed ? 1 : 0);
