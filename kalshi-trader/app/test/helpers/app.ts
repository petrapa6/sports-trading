import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { pino, type Logger } from 'pino';
import { DatabaseManager } from '../../src/db/database.js';
import { buildApp, type AppOptions } from '../../src/server/app.js';

export const TEST_SECRET = Buffer.alloc(32, 7);
/** Cheap argon2id parameters for tests that do not measure the real cost. */
export const FAST_ARGON2 = { memoryCost: 1024, timeCost: 1 };
export const TRUSTED_PROXIES = ['172.30.32.0/23'];

/** Options every test app needs besides the logger and database. */
export const TEST_APP_OPTIONS = {
  secretKey: TEST_SECRET,
  trustedProxies: TRUSTED_PROXIES,
  argon2: FAST_ARGON2,
};

export const INGRESS_PATH = '/api/hassio_ingress/abc';

/** A peer + headers combination that classifies as the given request class. */
export type Peer = { remoteAddress: string; headers: Record<string, string> };
export const ingress = (proto: 'http' | 'https' = 'http'): Peer => ({
  remoteAddress: '172.30.32.2',
  headers: { 'x-ingress-path': INGRESS_PATH, 'x-forwarded-proto': proto },
});
export const tunnel = (clientIp = '198.51.100.7'): Peer => ({
  remoteAddress: '172.30.33.5',
  headers: { 'cf-connecting-ip': clientIp },
});

/** Matches a V8 stack frame such as `    at foo (/x/y.ts:1:2)`. */
export const STACK_FRAME = /\bat\s+[^\s]+\s+\(?[^\s()]+:\d+:\d+\)?/;

export interface TestApp {
  app: FastifyInstance;
  manager: DatabaseManager;
  dir: string;
  logs: () => Record<string, unknown>[];
  close(): Promise<void>;
}

/** A migrated database in a temp dir and an app on it; `overrides` replace any `buildApp` option. */
export async function createTestApp(overrides: Partial<AppOptions> = {}, dir?: string): Promise<TestApp> {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'kst-app-'));
  let captured = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });
  const logger: Logger = pino({ level: 'info' }, sink);
  const manager = new DatabaseManager(join(root, 'db', 'trader.db'), logger);
  manager.open();
  const app = await buildApp({ logger, database: manager, ...TEST_APP_OPTIONS, ...overrides });
  return {
    app,
    manager,
    dir: root,
    logs: () =>
      captured
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    close: async () => {
      await app.close();
      manager.close();
      if (dir === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
}

interface RequestOptions {
  body?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * A browser-like client for `app.inject`: a fixed peer (request class), a cookie jar, and a check
 * that no response body ever contains a stack frame.
 */
export class Client {
  readonly cookies = new Map<string, string>();

  constructor(
    readonly app: FastifyInstance,
    public peer: Peer,
  ) {}

  async request(
    method: InjectOptions['method'],
    url: string,
    opts: RequestOptions = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...this.peer.headers, ...opts.headers };
    if (this.cookies.size > 0) {
      headers['cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let payload: string | undefined;
    if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }
    const res = await this.app.inject({
      method: method as NonNullable<InjectOptions['method']>,
      url,
      headers,
      remoteAddress: this.peer.remoteAddress,
      ...(payload !== undefined ? { payload } : {}),
    });
    if (STACK_FRAME.test(res.body)) throw new Error(`response body contains a stack frame: ${res.body}`);
    for (const c of res.cookies as unknown as {
      name: string;
      value: string;
      maxAge?: number;
      expires?: Date;
    }[]) {
      const expired =
        c.maxAge === 0 || (c.expires !== undefined && c.expires.getTime() <= Date.now()) || c.value === '';
      if (expired) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get(url: string, opts?: RequestOptions) {
    return this.request('GET', url, opts);
  }

  post(url: string, body?: unknown, opts: RequestOptions = {}) {
    return this.request('POST', url, { ...opts, body: body ?? {} });
  }

  /** Fetches a CSRF token for the current session. */
  async csrf(): Promise<string> {
    const res = await this.get('/api/csrf');
    if (res.statusCode !== 200) throw new Error(`GET /api/csrf → ${res.statusCode} ${res.body}`);
    return (res.json() as { token: string }).token;
  }

  /** POST with the session's CSRF token. */
  async postWithCsrf(url: string, body?: unknown): Promise<LightMyRequestResponse> {
    const token = await this.csrf();
    return this.post(url, body, { headers: { 'x-csrf-token': token } });
  }

  login(username: string, password: string, extra: Record<string, string> = {}) {
    return this.post('/login', { username, password, ...extra });
  }
}

export const USER = 'alice';
export const PASSWORD = 'correct horse battery staple';

/** Runs first-run setup via ingress, creating `alice`; returns the ingress client (signed in). */
export async function setupUser(app: FastifyInstance): Promise<Client> {
  const c = new Client(app, ingress());
  const res = await c.post('/setup', { username: USER, password: PASSWORD });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return c;
}
