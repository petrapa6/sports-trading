import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSync } from 'otplib';
import {
  Client,
  createTestApp,
  ingress,
  INGRESS_PATH,
  PASSWORD,
  setupUser,
  tunnel,
  USER,
  type TestApp,
} from '../helpers/app.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Spacing between /login calls so the 5/min rate limit never interferes with lockout tests. */
const LOGIN_SPACING_MS = 13_000;

let t: TestApp;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
  vi.useRealTimers();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function spacedLogin(
  c: Client,
  username: string,
  password: string,
  extra: Record<string, string> = {},
) {
  advance(LOGIN_SPACING_MS);
  return c.login(username, password, extra);
}

describe('routes require a session', () => {
  it('/api/anything → 401 {"error":"unauthorized"}; /healthz and /login are reachable without a session', async () => {
    const c = new Client(t.app, tunnel());
    const api = await c.get('/api/anything');
    expect(api.statusCode).toBe(401);
    expect(api.json()).toEqual({ error: 'unauthorized' });
    expect((await c.post('/api/settings', {})).statusCode).toBe(401);
    expect((await c.get('/auth/me')).statusCode).toBe(401);
    expect((await c.get('/healthz')).statusCode).toBe(200);
    const login = await c.get('/login');
    expect(login.statusCode).toBe(200);
    expect(login.headers['content-type']).toMatch(/^text\/html/);
    expect((await c.get('/assets/auth.css')).statusCode).toBe(200);
  });

  it('a browser navigation without a session is redirected to the login page (ingress prefix kept)', async () => {
    const tc = new Client(t.app, tunnel());
    const res = await tc.get('/', { headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login');
    const ic = new Client(t.app, ingress());
    const res2 = await ic.get('/', { headers: { accept: 'text/html' } });
    expect(res2.headers.location).toBe(`${INGRESS_PATH}/login`);
  });

  it('a session cookie with a forged signature or unknown id is rejected', async () => {
    const c = new Client(t.app, tunnel());
    c.cookies.set('kst_session', 'abc.def');
    expect((await c.get('/auth/me')).statusCode).toBe(401);
  });
});

describe('first-run setup', () => {
  it('empty users + ingress → user created (argon2id); second call → 410; tunnel → 403', async () => {
    const tc = new Client(t.app, tunnel());
    expect((await tc.post('/setup', { username: USER, password: PASSWORD })).statusCode).toBe(403);
    expect((await tc.get('/setup')).statusCode).toBe(403);

    const ic = new Client(t.app, ingress());
    expect((await ic.get('/setup')).statusCode).toBe(200);
    const first = await ic.post('/setup', { username: USER, password: PASSWORD });
    expect(first.statusCode).toBe(201);
    const users = t.manager.repositories.users.list();
    expect(users).toHaveLength(1);
    expect(users[0]?.username).toBe(USER);
    expect(users[0]?.password_hash).toMatch(/^\$argon2id\$/);

    const second = await new Client(t.app, ingress()).post('/setup', { username: 'bob', password: PASSWORD });
    expect(second.statusCode).toBe(410);
    expect(t.manager.repositories.users.count()).toBe(1);
    // Setup signs the user in.
    expect((await ic.get('/auth/me')).json()).toMatchObject({ username: USER });
    expect(t.manager.repositories.auditLog.list().map((r) => r.action)).toContain('setup');
  });

  it('dev class may run setup; a too-short password or an unknown field is rejected', async () => {
    const t2 = await createTestApp({ nodeEnv: 'development' });
    try {
      const c = new Client(t2.app, { remoteAddress: '127.0.0.1', headers: {} });
      expect((await c.post('/setup', { username: USER, password: 'short' })).statusCode).toBe(400);
      expect((await c.post('/setup', { username: USER, password: PASSWORD, admin: true })).statusCode).toBe(
        400,
      );
      expect((await c.post('/setup', { username: USER, password: PASSWORD })).statusCode).toBe(201);
    } finally {
      await t2.close();
    }
  });

  it('the HTML setup and login forms work end to end', async () => {
    const c = new Client(t.app, ingress());
    const setup = await c.request('POST', '/setup', { form: { username: USER, password: PASSWORD } });
    expect(setup.statusCode).toBe(303);
    expect(setup.headers.location).toBe('./');
    const home = await c.get('/');
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain(USER);
    const token = /name="_csrf" value="([^"]+)"/.exec(home.body)?.[1];
    expect(token).toBeDefined();
    const logout = await c.request('POST', '/auth/logout', { form: { _csrf: token ?? '' } });
    expect(logout.statusCode).toBe(303);
    expect((await c.get('/auth/me')).statusCode).toBe(401);
    const bad = await c.request('POST', '/login', { form: { username: USER, password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toContain('Wrong username or password');
    advance(LOGIN_SPACING_MS);
    const good = await c.request('POST', '/login', { form: { username: USER, password: PASSWORD } });
    expect(good.statusCode).toBe(303);
    expect((await c.get('/auth/me')).statusCode).toBe(200);
  });
});

describe('login lockout', () => {
  it('tunnel: 10 wrong passwords → the 11th (correct) is 429; +15 min → success; a second lockout lasts 30 min', async () => {
    await setupUser(t.app);
    const repos = t.manager.repositories;
    const c = new Client(t.app, tunnel());
    for (let i = 0; i < 10; i++) {
      const res = await spacedLogin(c, USER, 'wrong password');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_credentials' });
    }
    const locked = await spacedLogin(c, USER, PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: 'locked_out' });
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(repos.loginAttempts.count()).toBe(11);
    const lockouts = repos.auditLog.list().filter((r) => r.action === 'lockout');
    expect(lockouts.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lockouts[0]?.detail ?? '{}')).toMatchObject({ minutes: 15, level: 1 });
    expect(lockouts[0]).toMatchObject({ channel: 'tunnel', ip: '198.51.100.7' });

    advance(15 * MIN);
    expect((await c.login(USER, PASSWORD)).statusCode).toBe(200);

    // Second lockout: doubled to 30 minutes.
    for (let i = 0; i < 10; i++) expect((await spacedLogin(c, USER, 'wrong again')).statusCode).toBe(401);
    expect((await spacedLogin(c, USER, PASSWORD)).statusCode).toBe(429);
    const second = repos.auditLog
      .list()
      .filter((r) => r.action === 'lockout')
      .at(-1);
    expect(JSON.parse(second?.detail ?? '{}')).toMatchObject({ minutes: 30, level: 2 });
    advance(16 * MIN);
    expect((await c.login(USER, PASSWORD)).statusCode).toBe(429);
    advance(15 * MIN);
    expect((await c.login(USER, PASSWORD)).statusCode).toBe(200);
  });

  it('per client IP: 10 failures for different usernames lock that IP only', async () => {
    await setupUser(t.app);
    const attacker = new Client(t.app, tunnel('203.0.113.50'));
    for (let i = 0; i < 10; i++) expect((await spacedLogin(attacker, `user${i}`, 'x')).statusCode).toBe(401);
    expect((await spacedLogin(attacker, USER, PASSWORD)).statusCode).toBe(429);
    expect((await spacedLogin(new Client(t.app, tunnel('203.0.113.51')), USER, PASSWORD)).statusCode).toBe(
      200,
    );
  });

  it('ingress: the same 10 failures cause no lockout; the correct password succeeds', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, ingress());
    for (let i = 0; i < 10; i++) expect((await spacedLogin(c, USER, 'wrong password')).statusCode).toBe(401);
    expect((await spacedLogin(c, USER, PASSWORD)).statusCode).toBe(200);
    expect(t.manager.repositories.auditLog.list().some((r) => r.action === 'lockout')).toBe(false);
    const attempts = t.manager.repositories.loginAttempts.list();
    expect(attempts).toHaveLength(11);
    expect(attempts.every((a) => a.channel === 'ingress')).toBe(true);
  });

  it('every attempt is written to login_attempts and audit_log with IP and channel', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await spacedLogin(c, 'nobody', 'x');
    await spacedLogin(c, USER, PASSWORD);
    const attempts = t.manager.repositories.loginAttempts.list();
    expect(attempts.map((a) => [a.username, a.ok, a.ip, a.channel])).toEqual([
      ['nobody', 0, '198.51.100.7', 'tunnel'],
      [USER, 1, '198.51.100.7', 'tunnel'],
    ]);
    const audit = t.manager.repositories.auditLog.list().filter((r) => r.action.startsWith('login'));
    expect(audit.map((r) => [r.action, r.ip, r.channel])).toEqual([
      ['login_failed', '198.51.100.7', 'tunnel'],
      ['login', '198.51.100.7', 'tunnel'],
    ]);
  });
});

describe('session cookies and lifetime', () => {
  const cookieOf = (res: { headers: Record<string, unknown> }, name: string) => {
    const raw = res.headers['set-cookie'];
    const all = (Array.isArray(raw) ? raw : [raw]) as string[];
    const found = all.find((c) => c.startsWith(`${name}=`));
    expect(found, `Set-Cookie ${name}`).toBeDefined();
    return found ?? '';
  };

  it('tunnel login: kst_session; HttpOnly; Secure; SameSite=Strict; Path=/', async () => {
    await setupUser(t.app);
    const res = await new Client(t.app, tunnel()).login(USER, PASSWORD);
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res, 'kst_session');
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(cookie).toMatch(/; Path=\/(;|$)/);
  });

  it('ingress login: kst_session_ingress, Path=<X-Ingress-Path>, Secure only for https', async () => {
    await setupUser(t.app);
    const http = await new Client(t.app, ingress('http')).login(USER, PASSWORD);
    const c1 = cookieOf(http, 'kst_session_ingress');
    expect(c1).toContain(`Path=${INGRESS_PATH}`);
    expect(c1).toMatch(/; HttpOnly/);
    expect(c1).toMatch(/; SameSite=Strict/);
    expect(c1).not.toMatch(/; Secure/);
    advance(LOGIN_SPACING_MS);
    const https = await new Client(t.app, ingress('https')).login(USER, PASSWORD);
    expect(cookieOf(https, 'kst_session_ingress')).toMatch(/; Secure/);
  });

  it('an ingress session is not accepted outside ingress and vice versa', async () => {
    await setupUser(t.app);
    const ic = new Client(t.app, ingress());
    await ic.login(USER, PASSWORD);
    const moved = new Client(t.app, tunnel());
    moved.cookies.set('kst_session', ic.cookies.get('kst_session_ingress') ?? '');
    expect((await moved.get('/auth/me')).statusCode).toBe(401);
  });

  it('the session id is rotated on login and differs from every earlier id', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      expect((await spacedLogin(c, USER, PASSWORD)).statusCode).toBe(200);
      const id = c.cookies.get('kst_session') ?? '';
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    // The presented session was replaced, not kept alongside the new one (setup session + 1 tunnel session).
    expect(t.manager.repositories.sessions.count()).toBe(2);
  });

  it('+12 h 1 min idle → 401', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await c.login(USER, PASSWORD);
    advance(12 * HOUR - MIN);
    expect((await c.get('/auth/me')).statusCode).toBe(200);
    advance(12 * HOUR + MIN);
    expect((await c.get('/auth/me')).statusCode).toBe(401);
  });

  it('hourly activity but +7 d 1 min total → 401', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await c.login(USER, PASSWORD);
    for (let h = 1; h <= 7 * 24; h++) {
      advance(HOUR);
      const res = await c.get('/auth/me');
      expect(res.statusCode, `hour ${h}`).toBe(h < 7 * 24 ? 200 : 401);
      if (h === 7 * 24 - 1) {
        advance(59 * MIN);
        expect((await c.get('/auth/me')).statusCode).toBe(200);
        advance(-59 * MIN);
      }
    }
    // Exactly 7 d 1 min after login.
    advance(MIN - HOUR);
    expect((await c.get('/auth/me')).statusCode).toBe(401);
  });

  it('sessions can be listed and revoked; logout ends the session', async () => {
    const ic = await setupUser(t.app);
    const tc = new Client(t.app, tunnel());
    await tc.login(USER, PASSWORD);
    const list = (await ic.get('/auth/sessions')).json() as {
      sessions: { id: string; current: boolean; channel: string }[];
    };
    expect(list.sessions).toHaveLength(2);
    const other = list.sessions.find((s) => !s.current);
    expect(other?.channel).toBe('tunnel');
    expect((await ic.postWithCsrf(`/auth/sessions/${other?.id}/revoke`)).statusCode).toBe(200);
    expect((await tc.get('/auth/me')).statusCode).toBe(401);
    expect((await ic.postWithCsrf('/auth/logout')).statusCode).toBe(200);
    expect((await ic.get('/auth/me')).statusCode).toBe(401);
    const actions = t.manager.repositories.auditLog.list().map((r) => r.action);
    expect(actions).toContain('session_revoke');
    expect(actions).toContain('logout');
  });
});

describe('CSRF', () => {
  it('POST /api/settings without the token → 403; with the token from GET /api/csrf → 200', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await c.login(USER, PASSWORD);
    const without = await c.post('/api/settings', { order_group_contract_limit: 150 });
    expect(without.statusCode).toBe(403);
    expect(without.json()).toEqual({ error: 'csrf' });
    const token = await c.csrf();
    const wrong = await c.post(
      '/api/settings',
      { order_group_contract_limit: 150 },
      { headers: { 'x-csrf-token': 'x' + token } },
    );
    expect(wrong.statusCode).toBe(403);
    const ok = await c.post(
      '/api/settings',
      { order_group_contract_limit: 150 },
      { headers: { 'x-csrf-token': token } },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ order_group_contract_limit: 150 });
    expect(t.manager.repositories.settings.get('order_group_contract_limit')).toBe(150);
    expect(t.manager.repositories.auditLog.list().some((r) => r.action === 'settings_change')).toBe(true);
    // Unknown fields are rejected.
    const unknown = await c.post(
      '/api/settings',
      { global_dry_run: false },
      { headers: { 'x-csrf-token': token } },
    );
    expect(unknown.statusCode).toBe(400);
  });

  it('a token is bound to its session', async () => {
    await setupUser(t.app);
    const a = new Client(t.app, tunnel('198.51.100.1'));
    const b = new Client(t.app, tunnel('198.51.100.2'));
    await a.login(USER, PASSWORD);
    await b.login(USER, PASSWORD);
    const tokenA = await a.csrf();
    await b.csrf(); // gives b its own CSRF secret cookie
    const res = await b.post('/api/settings', {}, { headers: { 'x-csrf-token': tokenA } });
    expect(res.statusCode).toBe(403);
  });
});

describe('step-up authentication', () => {
  it('requireRecentAuth → 403 reauth_required at 5 min 1 s, 200 after POST /auth/reauth', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await c.login(USER, PASSWORD);
    advance(5 * MIN + 1000);
    const stale = await c.postWithCsrf('/auth/password', { newPassword: 'another long password' });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toEqual({ error: 'reauth_required' });
    const wrong = await c.postWithCsrf('/auth/reauth', { password: 'nope' });
    expect(wrong.statusCode).toBe(401);
    const reauth = await c.postWithCsrf('/auth/reauth', { password: PASSWORD });
    expect(reauth.statusCode).toBe(200);
    const fresh = await c.postWithCsrf('/auth/password', { newPassword: 'another long password' });
    expect(fresh.statusCode).toBe(200);
    // The new password works, the old one does not; other sessions were revoked.
    advance(LOGIN_SPACING_MS);
    expect((await new Client(t.app, tunnel('198.51.100.9')).login(USER, PASSWORD)).statusCode).toBe(401);
    expect(
      (await new Client(t.app, tunnel('198.51.100.9')).login(USER, 'another long password')).statusCode,
    ).toBe(200);
    expect(t.manager.repositories.auditLog.list().map((r) => r.action)).toEqual(
      expect.arrayContaining(['reauth_failed', 'reauth', 'password_change']),
    );
  });

  it('exactly at 5 min the session still counts as recent', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await c.login(USER, PASSWORD);
    advance(5 * MIN);
    expect((await c.postWithCsrf('/auth/totp/enrol', {})).statusCode).toBe(200);
  });
});

describe('TOTP', () => {
  const code = (secret: string) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) });

  it('enrol → otpauth URI; a code from its secret verifies; login then needs a code; disable restores password-only', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await c.login(USER, PASSWORD);
    const enrol = await c.postWithCsrf('/auth/totp/enrol', {});
    expect(enrol.statusCode).toBe(200);
    const { otpauthUri, secret } = enrol.json() as { otpauthUri: string; secret: string };
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect((await c.postWithCsrf('/auth/totp/confirm', { code: '000000' })).statusCode).toBe(400);
    const confirm = await c.postWithCsrf('/auth/totp/confirm', { code: code(secret) });
    expect(confirm.statusCode).toBe(200);
    const { recoveryCodes } = confirm.json() as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    const user = t.manager.repositories.users.get({ id: 1 });
    expect(user?.totp_secret_enc).not.toContain(secret);
    expect(JSON.parse(user?.recovery_codes_hash ?? '[]')).toHaveLength(10);

    const other = new Client(t.app, tunnel('198.51.100.20'));
    const noCode = await spacedLogin(other, USER, PASSWORD);
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json()).toEqual({ error: 'totp_required' });
    expect((await spacedLogin(other, USER, PASSWORD, { totp: '123456' })).statusCode).toBe(401);
    advance(30_000);
    const current = code(secret);
    const withCode = await other.login(USER, PASSWORD, { totp: current });
    expect(withCode.statusCode).toBe(200);
    // The same code cannot be replayed.
    expect(
      (await new Client(t.app, tunnel('198.51.100.21')).login(USER, PASSWORD, { totp: current })).statusCode,
    ).toBe(401);

    expect((await other.postWithCsrf('/auth/totp/disable', {})).statusCode).toBe(200);
    const plain = await spacedLogin(new Client(t.app, tunnel('198.51.100.22')), USER, PASSWORD);
    expect(plain.statusCode).toBe(200);
    const actions = t.manager.repositories.auditLog.list().map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['totp_enable', 'totp_disable']));
  });

  it('each of the 10 recovery codes works exactly once', async () => {
    const ic = await setupUser(t.app);
    const { secret } = (await ic.postWithCsrf('/auth/totp/enrol', {})).json() as { secret: string };
    const { recoveryCodes } = (
      await ic.postWithCsrf('/auth/totp/confirm', { code: code(secret) })
    ).json() as {
      recoveryCodes: string[];
    };
    const c = new Client(t.app, ingress());
    for (const [i, rc] of recoveryCodes.entries()) {
      const first = await spacedLogin(c, USER, PASSWORD, { recoveryCode: rc });
      expect(first.statusCode, `code ${i} first use`).toBe(200);
      const again = await spacedLogin(c, USER, PASSWORD, { recoveryCode: rc });
      expect(again.statusCode, `code ${i} reuse`).toBe(401);
    }
    expect(t.manager.repositories.users.get({ id: 1 })?.recovery_codes_hash).toBe('[]');
    expect(
      t.manager.repositories.auditLog.list().filter((r) => r.action === 'recovery_code_used'),
    ).toHaveLength(10);
  });
});
