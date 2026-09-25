/**
 * `npm run verify:T03` — runs the T03 acceptance checks (SPEC.md §14) and prints PASS / FAIL per
 * item. Each item runs its Vitest file(s) under `test/security/` and, where the check can be made
 * over real HTTP, repeats it with `fetch` against `npm run dev` (the curl equivalents are in
 * docs/verification/T03.md).
 *
 * The dev server runs with `TRUSTED_PROXIES=127.0.0.1/32`, so a loopback request carrying
 * `CF-Connecting-IP` is classified `tunnel` and one without it `dev` (NODE_ENV=development).
 * It uses `./.local/verify-T03/` (removed first), never the developer's own `./.local` data.
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP,
  assert,
  check,
  cleanEnv,
  finish,
  record,
  startDev,
  vitest,
  waitForHealth,
} from './verify-lib.js';

const BASE = join(APP, '.local/verify-T03');
const PORT = 8197;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const TUNNEL = { 'cf-connecting-ip': '198.51.100.7' };
const PASSWORD = 'verify-T03 long password';

type Res = { status: number; headers: Headers; body: string; cookies: string[] };

async function http(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; cookie?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(URL_BASE + path, {
    method,
    headers,
    redirect: 'manual',
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: await res.text(),
    cookies: res.headers.getSetCookie(),
  };
}

/** `name=value` pairs from Set-Cookie headers, as a Cookie header. */
const jar = (...lists: string[][]): string =>
  lists
    .flat()
    .map((c) => c.split(';')[0])
    .join('; ');

rmSync(BASE, { recursive: true, force: true });
const dev = startDev(
  cleanEnv({
    PORT: String(PORT),
    DB_PATH: './.local/verify-T03/trader.db',
    DATA_DIR: './.local/verify-T03/data',
    TRUSTED_PROXIES: '127.0.0.1/32',
  }),
);

try {
  await waitForHealth(PORT, 15_000);

  await check('Classification table (ingress / tunnel / other / dev)', () =>
    vitest(['test/security/requestClass.test.ts']),
  );

  await check(
    'curl /api/anything → 401 {"error":"unauthorized"}; /healthz and /login reachable',
    async () => {
      const api = await http('GET', '/api/anything');
      assert(api.status === 401 && api.body === '{"error":"unauthorized"}', `${api.status} ${api.body}`);
      const health = await http('GET', '/healthz');
      const login = await http('GET', '/login');
      assert(
        health.status === 200 && login.status === 200,
        `healthz ${health.status}, login ${login.status}`,
      );
      return `live: /api/anything 401 ${api.body}; /healthz 200; /login 200; ${vitest(['test/security/auth.test.ts'], 'routes require a session')}`;
    },
  );

  let session = '';
  await check('Setup: empty users + ingress → created; second call → 410; tunnel → 403', async () => {
    const tunnel = await http('POST', '/setup', {
      headers: TUNNEL,
      body: { username: 'pavel', password: PASSWORD },
    });
    assert(tunnel.status === 403, `tunnel setup ${tunnel.status}`);
    const first = await http('POST', '/setup', { body: { username: 'pavel', password: PASSWORD } });
    assert(first.status === 201, `dev setup ${first.status} ${first.body}`);
    const second = await http('POST', '/setup', { body: { username: 'other', password: PASSWORD } });
    assert(second.status === 410, `second setup ${second.status}`);
    session = jar(first.cookies);
    return `live (dev class stands in for ingress): tunnel 403, first 201, second 410; ${vitest(['test/security/auth.test.ts'], 'first-run setup')}`;
  });

  await check(
    'Lockout (tunnel 10 failures → 429, 11 attempts, lockout row, +15 min, 30 min; ingress none)',
    () => vitest(['test/security/auth.test.ts'], 'login lockout'),
  );

  await check('Timing: unknown username vs wrong password medians differ < 20 % (200 iterations)', () =>
    vitest(['test/security/timing.test.ts']),
  );

  let tunnelCookie = '';
  await check('Cookies per channel, rotation, 12 h idle and 7 d absolute expiry', async () => {
    const res = await http('POST', '/login', {
      headers: TUNNEL,
      body: { username: 'pavel', password: PASSWORD },
    });
    assert(res.status === 200, `tunnel login ${res.status} ${res.body}`);
    const c = res.cookies.find((x) => x.startsWith('kst_session='));
    assert(c, `no kst_session cookie: ${res.cookies.join(' | ')}`);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
      assert(c.split('; ').includes(attr), `${attr} missing in ${c}`);
    tunnelCookie = jar(res.cookies);
    return `live tunnel Set-Cookie: ${c.replace(/=[^;]+/, '=…')}; ${vitest(['test/security/auth.test.ts'], 'session cookies')}`;
  });

  await check(
    'POST /api/settings without CSRF token → 403; with token from GET /api/csrf → 200',
    async () => {
      const without = await http('POST', '/api/settings', { cookie: session, body: {} });
      assert(without.status === 403, `without token ${without.status} ${without.body}`);
      const csrf = await http('GET', '/api/csrf', { cookie: session });
      const token = (JSON.parse(csrf.body) as { token: string }).token;
      const cookie = jar(session.split('; '), csrf.cookies);
      const withToken = await http('POST', '/api/settings', {
        cookie,
        headers: { 'x-csrf-token': token },
        body: { order_group_contract_limit: 200 },
      });
      assert(withToken.status === 200, `with token ${withToken.status} ${withToken.body}`);
      return `live: 403 then 200; ${vitest(['test/security/auth.test.ts'], 'CSRF')}`;
    },
  );

  await check('requireRecentAuth: 403 reauth_required at 5 min 1 s, 200 after POST /auth/reauth', () =>
    vitest(['test/security/auth.test.ts'], 'step-up'),
  );

  await check(
    'Headers on /: CSP default-src self, no unsafe-inline scripts, no-referrer, framing per class',
    async () => {
      const res = await http('GET', '/', { headers: TUNNEL, cookie: tunnelCookie });
      assert(res.status === 200, `GET / ${res.status}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert(csp.includes("default-src 'self'") && !csp.includes('unsafe-inline'), csp);
      assert(csp.includes("frame-ancestors 'none'"), csp);
      assert(res.headers.get('x-frame-options') === 'DENY', `xfo ${res.headers.get('x-frame-options')}`);
      assert(res.headers.get('referrer-policy') === 'no-referrer', 'referrer-policy');
      return `live tunnel: DENY + frame-ancestors 'none'; ${vitest(['test/security/http.test.ts'], 'HTTP hardening headers')}`;
    },
  );

  await check('secret.key mode 600; deleting it and restarting makes every existing session 401', () => {
    const key = join(BASE, 'data/secret.key');
    assert(existsSync(key), 'secret.key missing');
    const mode = (statSync(key).mode & 0o777).toString(8);
    assert(mode === '600', `mode ${mode}`);
    return `live: ${key.replace(APP + '/', '')} mode ${mode}; ${vitest(['test/security/http.test.ts'], 'secret.key')}`;
  });

  await check("encryptSetting('abc') ≠ 'abc'; decryptSetting → 'abc'; other key throws", () =>
    vitest(['test/security/http.test.ts'], 'encryptSetting'),
  );

  await check('TOTP: otpauth URI, code verifies, totp_required, disable, recovery codes once each', () =>
    vitest(['test/security/auth.test.ts'], 'TOTP'),
  );

  await check('Rate limit: 301st /api/csrf → 429; assets unlimited; 6th /login → 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (
          await http('POST', '/login', {
            headers: { 'cf-connecting-ip': '203.0.113.9' },
            body: { username: 'x', password: 'y' },
          })
        ).status,
      );
    assert(statuses[5] === 429 && statuses.slice(0, 5).every((s) => s === 401), statuses.join(','));
    return `live /login: ${statuses.join(',')}; ${vitest(['test/security/http.test.ts'], 'rate limits')}`;
  });

  await check(
    'Errors are {"error":"internal","correlationId"} with the id logged; no stack frames in any response',
    () => vitest(['test/security']),
  );
} finally {
  await dev.stop();
}

const errors = dev
  .stdout()
  .split('\n')
  .filter((l) => l.includes('"level":50') || l.includes('"level":60'));
record(
  '(extra) dev server logged no error lines',
  errors.length === 0 ? 'PASS' : 'FAIL',
  `${errors.length} error lines`,
);
record('Branch pushed; GitHub Actions run green', 'MANUAL', 'see docs/verification/T03.md for the run URL');
rmSync(BASE, { recursive: true, force: true });
finish();
