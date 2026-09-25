import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/server/http.js';
import {
  decryptSetting,
  encryptSetting,
  loadOrCreateSecretKey,
  SecretKeyError,
} from '../../src/server/secrets.js';
import {
  Client,
  createTestApp,
  ingress,
  PASSWORD,
  setupUser,
  STACK_FRAME,
  tunnel,
  USER,
  type TestApp,
} from '../helpers/app.js';

describe('HTTP hardening headers', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  const scriptSrc = (csp: string) => csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';

  it.each([
    ['tunnel', tunnel(), 'DENY', "frame-ancestors 'none'"],
    ['ingress', ingress(), 'SAMEORIGIN', "frame-ancestors 'self'"],
    ['other', { remoteAddress: '10.0.0.9', headers: {} }, 'DENY', "frame-ancestors 'none'"],
  ] as const)(
    '%s: CSP, referrer policy and framing on / (signed out and signed in)',
    async (_name, peer, xfo, fa) => {
      await setupUser(t.app);
      const c = new Client(t.app, peer);
      const signedOut = await c.get('/', { headers: { accept: 'text/html' } });
      await c.login(USER, PASSWORD);
      const signedIn = await c.get('/');
      expect(signedIn.statusCode).toBe(200);
      for (const res of [signedOut, signedIn]) {
        const csp = String(res.headers['content-security-policy']);
        expect(csp).toContain("default-src 'self'");
        expect(scriptSrc(csp)).toContain("'self'");
        expect(csp).not.toContain('unsafe-inline');
        expect(csp).not.toContain('unsafe-eval');
        expect(csp).toContain(fa);
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['x-frame-options']).toBe(xfo);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      }
    },
  );

  it('HSTS only for the tunnel', async () => {
    expect(
      (await new Client(t.app, tunnel()).get('/healthz')).headers['strict-transport-security'],
    ).toBeDefined();
    expect(
      (await new Client(t.app, ingress()).get('/healthz')).headers['strict-transport-security'],
    ).toBeUndefined();
  });

  it('the login page has no inline script or style', async () => {
    const res = await new Client(t.app, tunnel()).get('/login');
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).not.toMatch(/style=/i);
    expect(res.body).not.toMatch(/<style/i);
  });

  it('bodies over 1 MB are rejected with 413', async () => {
    const c = new Client(t.app, tunnel());
    const res = await c.post('/login', { username: 'x', password: 'y'.repeat(1024 * 1024) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'payload_too_large' });
  });
});

describe('rate limits', () => {
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

  it('301 requests to /api/csrf within a minute from one client IP → the 301st is 429', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await c.login(USER, PASSWORD);
    const statuses: number[] = [];
    for (let i = 0; i < 301; i++) statuses.push((await c.get('/api/csrf')).statusCode);
    expect(statuses.slice(0, 300).every((s) => s === 200)).toBe(true);
    expect(statuses[300]).toBe(429);
    // Another client IP is unaffected; after the window the first one recovers.
    const other = new Client(t.app, tunnel('198.51.100.99'));
    expect((await other.get('/api/csrf')).statusCode).toBe(401);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await c.get('/api/csrf')).statusCode).toBe(200);
  });

  it('asset requests are not limited', async () => {
    const c = new Client(t.app, tunnel());
    for (let i = 0; i < 400; i++) expect((await c.get('/assets/auth.css')).statusCode).toBe(200);
    // …and do not use up the global budget.
    expect((await c.get('/healthz')).statusCode).toBe(200);
  });

  it('6 /login requests → the 6th is 429', async () => {
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.login(USER, 'wrong')).statusCode);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const g = new Client(t.app, tunnel('198.51.100.30'));
    const gets: number[] = [];
    for (let i = 0; i < 6; i++) gets.push((await g.get('/login')).statusCode);
    expect(gets).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('error responses', () => {
  it('500 → {"error":"internal","correlationId"} with the id in one log line; no stack frames', async () => {
    const t = await createTestApp();
    try {
      t.app.get('/api/boom', async () => {
        throw new Error('kaboom with a secret detail');
      });
      t.app.get('/api/http-error', async () => {
        throw new HttpError(409, 'conflict');
      });
      await setupUser(t.app);
      const c = new Client(t.app, tunnel());
      await c.login(USER, PASSWORD);
      const res = await c.get('/api/boom');
      expect(res.statusCode).toBe(500);
      const body = res.json() as { error: string; correlationId: string };
      expect(Object.keys(body).sort()).toEqual(['correlationId', 'error']);
      expect(body.error).toBe('internal');
      expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body).not.toContain('kaboom');
      expect(res.body).not.toMatch(STACK_FRAME);
      const lines = t.logs().filter((l) => l['correlationId'] === body.correlationId && l['level'] === 50);
      expect(lines).toHaveLength(1);
      expect(JSON.stringify(lines[0])).toContain('kaboom');

      expect((await c.get('/api/http-error')).json()).toEqual({ error: 'conflict' });
      const bad = await c.request('POST', '/auth/reauth', {
        headers: { 'content-type': 'application/json', 'x-csrf-token': await c.csrf() },
      });
      expect(bad.statusCode).toBe(400);
      const malformed = await t.app.inject({
        method: 'POST',
        url: '/login',
        remoteAddress: '10.0.0.1',
        headers: { 'content-type': 'application/json' },
        payload: '{"username":',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: 'bad_request' });
      expect(malformed.body).not.toMatch(STACK_FRAME);
      // Unknown path for a signed-in user.
      expect((await c.get('/api/nothing-here')).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

describe('secret.key and encrypted settings', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kst-secret-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('secret.key is generated with mode 600 and reused on the next start', () => {
    const first = loadOrCreateSecretKey(join(dir, 'data'));
    expect(first.generated).toBe(true);
    expect(first.key).toHaveLength(32);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    const second = loadOrCreateSecretKey(join(dir, 'data'));
    expect(second.generated).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });

  it('a secret.key of the wrong size is refused', () => {
    writeFileSync(join(dir, 'secret.key'), 'short');
    expect(() => loadOrCreateSecretKey(dir)).toThrow(SecretKeyError);
  });

  it('deleting secret.key and restarting makes every existing session 401', async () => {
    const dataDir = join(dir, 'data');
    const k1 = loadOrCreateSecretKey(dataDir);
    const a1 = await createTestApp({ secretKey: k1.key }, dir);
    await setupUser(a1.app);
    const c = new Client(a1.app, tunnel());
    await c.login(USER, PASSWORD);
    expect((await c.get('/auth/me')).statusCode).toBe(200);
    await a1.close();

    // Restart with the same key: the session survives.
    const a2 = await createTestApp({ secretKey: loadOrCreateSecretKey(dataDir).key }, dir);
    const c2 = new Client(a2.app, tunnel());
    for (const [k, v] of c.cookies) c2.cookies.set(k, v);
    expect((await c2.get('/auth/me')).statusCode).toBe(200);
    await a2.close();

    rmSync(k1.path);
    const k3 = loadOrCreateSecretKey(dataDir);
    expect(k3.generated).toBe(true);
    const a3 = await createTestApp({ secretKey: k3.key }, dir);
    const c3 = new Client(a3.app, tunnel());
    for (const [k, v] of c.cookies) c3.cookies.set(k, v);
    expect((await c3.get('/auth/me')).statusCode).toBe(401);
    await a3.close();
    expect(existsSync(k3.path)).toBe(true);
  });

  it("encryptSetting('abc') ≠ 'abc'; decryptSetting returns 'abc'; a different key throws", () => {
    const key = Buffer.alloc(32, 1);
    const enc = encryptSetting('abc', key);
    expect(enc).not.toBe('abc');
    expect(enc).not.toContain('abc');
    expect(encryptSetting('abc', key)).not.toBe(enc); // random IV
    expect(decryptSetting(enc, key)).toBe('abc');
    expect(() => decryptSetting(enc, Buffer.alloc(32, 2))).toThrow();
    const tampered = enc.slice(0, -2) + (enc.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptSetting(tampered, key)).toThrow();
  });
});
