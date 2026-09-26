/**
 * `npm run audit:security` (SPEC.md §10, §12 Test plan, T14): every security check in one command, one line per
 * check, a summary table at the end, exit 1 if any check fails.
 *
 *  1. the security test suite (`test/security`: request classes, lockout, sessions, CSRF, step-up, headers, …);
 *  2. `gitleaks` over the whole git history with `.gitleaks.toml` (as CI does);
 *  3. `npm audit --audit-level=high`;
 *  4. response headers per request class against a **running instance** of the production build
 *     (`npm run build`, then `node dist/server/main.js`): a strict CSP without `unsafe-inline` / `unsafe-eval` /
 *     wildcards, framing (`frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` for ingress, `'none'` + `DENY`
 *     for everything else), `Referrer-Policy: no-referrer`, `nosniff`, HSTS on tunnel responses, and no stack
 *     traces in error bodies — on an HTML page, a static asset, `/healthz` and an API error.
 *
 * The instance runs on a scratch database with `NODE_ENV=development` and `KST_E2E=1` so that all four classes can
 * be produced from this machine: loopback + `X-Ingress-Path` is `ingress` (KST_E2E makes loopback the ingress
 * proxy), loopback + `CF-Connecting-IP` is `tunnel` (`TRUSTED_PROXIES=127.0.0.1/32`), plain loopback is `dev`, and a
 * request to the machine's own non-loopback address is `other`. Headers are set by the same code in every mode.
 *
 * Options: `--skip-gitleaks` (prints SKIP instead of running it; the check then does not count as passed),
 * `--no-build` (use the existing `dist/`).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { APP, ROOT, cleanEnv, run, sleep } from './verify-lib.js';

const argv = process.argv.slice(2);
const PORT = Number(process.env['AUDIT_PORT'] ?? 8294);
type Outcome = 'PASS' | 'FAIL' | 'SKIP';
const rows: { check: string; outcome: Outcome; detail: string }[] = [];

function line(check: string, outcome: Outcome, detail: string): void {
  rows.push({ check, outcome, detail });
  console.log(`${outcome.padEnd(4)} ${check} — ${detail}`);
}

async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    line(name, 'PASS', await fn());
  } catch (err) {
    line(name, 'FAIL', (err as Error).message);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- 1. security test suite ---------------------------------------------------------------------------------

await check('security test suite (vitest test/security)', () => {
  const r = run('npx', ['vitest', 'run', 'test/security']);
  const passed = /Tests\s+(\d+) passed/.exec(r.out)?.[1];
  const files = /Test Files\s+(\d+) passed/.exec(r.out)?.[1];
  const failing = [...r.out.matchAll(/^ FAIL {2}(.+)$/gm)].map((m) => m[1]);
  assert(
    r.code === 0,
    failing.length > 0 ? `failing: ${[...new Set(failing)].join(' | ')}` : r.out.slice(-1500),
  );
  return `${passed ?? '?'} tests in ${files ?? '?'} files passed`;
});

// ---- 2. gitleaks ----------------------------------------------------------------------------------------------

if (argv.includes('--skip-gitleaks')) {
  line('gitleaks (git history, .gitleaks.toml)', 'SKIP', '--skip-gitleaks given');
} else {
  await check('gitleaks (git history, .gitleaks.toml)', () => {
    const bin = process.env['GITLEAKS'] ?? 'gitleaks';
    const r = run(bin, ['git', '--redact', '--no-banner', '--config', '.gitleaks.toml', '.'], { cwd: ROOT });
    assert(
      r.out.trim() !== '' || r.code === 0,
      `${bin} did not run (not installed? go install github.com/zricethezav/gitleaks/v8@v8.30.1, or set GITLEAKS)`,
    );
    assert(r.code === 0, r.out.slice(-1500));
    const commits = /(\d+) commits scanned/.exec(r.out)?.[1];
    return `no leaks found${commits ? ` in ${commits} commits` : ''}`;
  });
}

// ---- 3. npm audit ---------------------------------------------------------------------------------------------

await check('npm audit --audit-level=high', () => {
  const r = run('npm', ['audit', '--audit-level=high']);
  assert(r.code === 0, r.out.slice(-1500));
  const summary =
    r.out
      .split('\n')
      .filter((l) => /vulnerabilit/.test(l) && !/npm audit fix/.test(l))
      .join('; ')
      .trim() || 'no high or critical vulnerabilities';
  return summary.replace(/\s+/g, ' ');
});

// ---- 4. headers per request class against a running instance ------------------------------------------------

if (!argv.includes('--no-build')) {
  const b = run('npm', ['run', 'build']);
  if (b.code !== 0)
    line('npm run build (production build for the header checks)', 'FAIL', b.out.slice(-1500));
}

const scratch = join(APP, '.local/audit-security');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const server = spawn(process.execPath, ['dist/server/main.js'], {
  cwd: APP,
  env: cleanEnv({
    NODE_ENV: 'development',
    KST_E2E: '1',
    PORT: String(PORT),
    DB_PATH: join(scratch, 'trader.db'),
    DATA_DIR: join(scratch, 'data'),
    TRUSTED_PROXIES: '127.0.0.1/32',
    LOG_LEVEL: 'warn',
  }),
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
});
let serverErr = '';
server.stderr?.on('data', (d: Buffer) => (serverErr += d.toString()));

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A GET to `host:PORT` with the given headers (node:http, so no header is added or hidden). */
function get(host: string, path: string, headers: Record<string, string>): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port: PORT, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout: GET ${path}`)));
    req.end();
  });
}

const h = (r: Res, name: string): string => {
  const v = r.headers[name];
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
};

/** CSP directives by name. */
function parseCsp(csp: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) m.set(name.toLowerCase(), values);
  }
  return m;
}

const STACK_FRAME = /\bat\s+[^\s]+\s+\(?[^\s()]+:\d+:\d+\)?/;

/** Every header rule for one response of one class; returns the problems found. */
function problems(cls: string, what: string, r: Res): string[] {
  const out: string[] = [];
  const ingress = cls === 'ingress';
  const csp = h(r, 'content-security-policy');
  if (!csp) out.push(`${what}: no Content-Security-Policy`);
  else {
    const d = parseCsp(csp);
    const all = [...d.values()].flat();
    for (const bad of [
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'unsafe-hashes'",
      '*',
      'http:',
      'https:',
      'data:',
    ])
      if (all.filter((v) => !(bad === 'data:' && d.get('img-src')?.includes(v))).includes(bad))
        out.push(`${what}: CSP allows ${bad}`);
    if ((d.get('default-src') ?? []).join(' ') !== "'self'") out.push(`${what}: default-src is not 'self'`);
    if ((d.get('script-src') ?? []).join(' ') !== "'self'") out.push(`${what}: script-src is not 'self'`);
    if ((d.get('object-src') ?? []).join(' ') !== "'none'") out.push(`${what}: object-src is not 'none'`);
    const fa = (d.get('frame-ancestors') ?? []).join(' ');
    if (fa !== (ingress ? "'self'" : "'none'")) out.push(`${what}: frame-ancestors ${fa || '(missing)'}`);
  }
  const xfo = h(r, 'x-frame-options');
  if (xfo !== (ingress ? 'SAMEORIGIN' : 'DENY')) out.push(`${what}: X-Frame-Options ${xfo || '(missing)'}`);
  if (h(r, 'referrer-policy') !== 'no-referrer')
    out.push(`${what}: Referrer-Policy ${h(r, 'referrer-policy')}`);
  if (h(r, 'x-content-type-options') !== 'nosniff') out.push(`${what}: X-Content-Type-Options missing`);
  if (cls === 'tunnel' && !h(r, 'strict-transport-security').includes('max-age='))
    out.push(`${what}: no Strict-Transport-Security on a tunnel response`);
  if (h(r, 'x-powered-by')) out.push(`${what}: X-Powered-By ${h(r, 'x-powered-by')}`);
  if (STACK_FRAME.test(r.body)) out.push(`${what}: stack frame in the body`);
  return out;
}

function ownAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return undefined;
}

try {
  let up = false;
  for (let i = 0; i < 150 && !up && server.exitCode === null; i++) {
    try {
      await get('127.0.0.1', '/healthz', {});
      up = true;
    } catch {
      await sleep(200);
    }
  }
  if (!up) {
    line(
      'running instance (dist/server/main.js)',
      'FAIL',
      `did not answer on :${PORT}: ${serverErr.slice(-1500)}`,
    );
  } else {
    const assetsDir = join(APP, 'dist/web/assets');
    const asset = existsSync(assetsDir) ? readdirSync(assetsDir).find((f) => f.endsWith('.js')) : undefined;
    const other = ownAddress();
    const classes: { cls: string; host: string | undefined; headers: Record<string, string>; how: string }[] =
      [
        {
          cls: 'ingress',
          host: '127.0.0.1',
          headers: { 'x-ingress-path': '/api/hassio_ingress/audit' },
          how: 'loopback + X-Ingress-Path',
        },
        {
          cls: 'tunnel',
          host: '127.0.0.1',
          headers: { 'cf-connecting-ip': '198.51.100.7' },
          how: 'loopback (trusted proxy) + CF-Connecting-IP',
        },
        { cls: 'dev', host: '127.0.0.1', headers: {}, how: 'loopback, NODE_ENV=development' },
        { cls: 'other', host: other, headers: {}, how: `peer ${other ?? '(no non-loopback address)'}` },
      ];
    for (const c of classes) {
      await check(`headers: ${c.cls} (${c.how})`, async () => {
        assert(c.host !== undefined, 'this machine has no non-loopback IPv4 address to connect from');
        const paths = ['/login', '/healthz', '/api/status', ...(asset ? [`/assets/${asset}`] : [])];
        const found: string[] = [];
        const seen: string[] = [];
        for (const path of paths) {
          const r = await get(c.host, path, { accept: 'text/html', ...c.headers });
          found.push(...problems(c.cls, `${path} (${r.status})`, r));
          seen.push(`${path} ${r.status}`);
        }
        assert(asset !== undefined, 'no static asset in dist/web/assets (build missing?)');
        assert(found.length === 0, found.join('; '));
        const sample = await get(c.host, '/login', c.headers);
        const csp = parseCsp(h(sample, 'content-security-policy'));
        return `${seen.join(', ')}: CSP strict, frame-ancestors ${(csp.get('frame-ancestors') ?? []).join(' ')}, X-Frame-Options ${h(sample, 'x-frame-options')}${c.cls === 'tunnel' ? ', HSTS' : ''}, no-referrer, nosniff`;
      });
    }
  }
} finally {
  if (server.pid !== undefined)
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // already gone
    }
}

// ---- summary --------------------------------------------------------------------------------------------------

const width = Math.max(...rows.map((r) => r.check.length));
console.log(`\n${'Check'.padEnd(width)}  Result`);
console.log(`${'-'.repeat(width)}  ------`);
for (const r of rows) console.log(`${r.check.padEnd(width)}  ${r.outcome}`);
const failed = rows.filter((r) => r.outcome === 'FAIL').length;
const skipped = rows.filter((r) => r.outcome === 'SKIP').length;
console.log(
  `\n${rows.length - failed - skipped} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}.`,
);
process.exit(failed ? 1 : 0);
