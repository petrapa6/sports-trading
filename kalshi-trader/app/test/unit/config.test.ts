import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, missingKalshiCredentials, readPrivateKey } from '../../src/config.js';

const NO_FILE = '/nonexistent/config.local.json';

function withLocal(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'kst-config-'));
  const path = join(dir, 'config.local.json');
  writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return path;
}

function load(env: Record<string, string>, configLocalPath = NO_FILE) {
  return loadConfig({ env, configLocalPath }).config;
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig defaults', () => {
  it('works with nothing configured', () => {
    const c = load({});
    expect(c).toEqual({
      kalshiEnv: 'demo',
      kalshiSubaccount: 0,
      allowLiveOrders: false,
      logLevel: 'info',
      dataDir: './.local/data',
      dbPath: './.local/trader.db',
      port: 8099,
      trustedProxies: ['172.30.32.0/23'],
    });
    expect(missingKalshiCredentials(c)).toEqual([
      'KALSHI_KEY_ID',
      'KALSHI_PRIVATE_KEY_FD or kalshiPrivateKeyPath',
    ]);
  });

  it('treats empty env vars as unset (run.sh exports blanks)', () => {
    const c = load({ KALSHI_KEY_ID: '', TZ: '', PORT: '' });
    expect(c.kalshiKeyId).toBeUndefined();
    expect(c.port).toBe(8099);
  });
});

describe('loadConfig parsing', () => {
  it('parses every env var', () => {
    const c = load({
      KALSHI_ENV: 'prod',
      KALSHI_KEY_ID: 'abc',
      KALSHI_PRIVATE_KEY_FD: '3',
      KALSHI_SUBACCOUNT: '5',
      ALLOW_LIVE_ORDERS: 'true',
      LOG_LEVEL: 'debug',
      DATA_DIR: '/data/app',
      DB_PATH: '/share/kalshi-trader/trader.db',
      PORT: '8099',
      TRUSTED_PROXIES: '172.30.32.0/23, 10.0.0.1',
      TZ: 'Europe/Prague',
    });
    expect(c).toMatchObject({
      kalshiEnv: 'prod',
      kalshiKeyId: 'abc',
      kalshiPrivateKeyFd: 3,
      kalshiSubaccount: 5,
      allowLiveOrders: true,
      logLevel: 'debug',
      trustedProxies: ['172.30.32.0/23', '10.0.0.1'],
      tz: 'Europe/Prague',
    });
    expect(missingKalshiCredentials(c)).toEqual([]);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['LOG_LEVEL', 'nope'],
    ['ALLOW_LIVE_ORDERS', 'maybe'],
    ['ALLOW_LIVE_ORDERS', '1'],
    ['KALSHI_ENV', 'staging'],
    ['KALSHI_SUBACCOUNT', '64'],
    ['KALSHI_PRIVATE_KEY_FD', 'three'],
    ['TRUSTED_PROXIES', '172.30.32.0/99'],
    ['TRUSTED_PROXIES', 'not-an-ip'],
    ['TZ', 'Mars/Olympus'],
  ])('rejects %s=%j naming the key', (key, value) => {
    const err = errorOf(() => load({ [key]: value }));
    expect(err.message).toContain(key);
    expect(err.keys).toContain(key);
  });

  it('reports every bad key at once', () => {
    const err = errorOf(() => load({ PORT: 'abc', LOG_LEVEL: 'nope' }));
    expect(err.keys).toEqual(expect.arrayContaining(['PORT', 'LOG_LEVEL']));
  });
});

describe('config.local.json', () => {
  it('is honoured, and env overrides it', () => {
    const path = withLocal({ port: 8123, allowLiveOrders: true, kalshiPrivateKeyPath: '/keys/demo.pem' });
    expect(load({}, path)).toMatchObject({
      port: 8123,
      allowLiveOrders: true,
      kalshiPrivateKeyPath: '/keys/demo.pem',
    });
    expect(load({ PORT: '8124' }, path).port).toBe(8124);
  });

  it('accepts the committed example (all values empty)', async () => {
    const example = new URL('../../config.local.example.json', import.meta.url);
    const c = loadConfig({ env: {}, configLocalPath: example.pathname }).config;
    expect(c.port).toBe(8099);
    expect(c.allowLiveOrders).toBe(false);
  });

  it('names bad values and unknown keys', () => {
    expect(errorOf(() => load({}, withLocal({ port: 'x' }))).message).toMatch(
      /port \(.*config\.local\.json\)/,
    );
    expect(errorOf(() => load({}, withLocal({ prot: 8000 }))).keys).toContain('prot');
  });

  it('rejects invalid JSON', () => {
    expect(errorOf(() => load({}, withLocal('{nope'))).message).toContain('not valid JSON');
  });

  it('can be selected with CONFIG_LOCAL_PATH', () => {
    const path = withLocal({ port: 9001 });
    expect(loadConfig({ env: { CONFIG_LOCAL_PATH: path } }).config.port).toBe(9001);
  });
});

describe('readPrivateKey', () => {
  const pem = ['-----BEGIN ', 'PRIVATE KEY-----\nMIIfake\n-----END ', 'PRIVATE KEY-----\n'].join('');

  it('returns undefined when nothing is configured', () => {
    expect(readPrivateKey(load({}))).toBeUndefined();
  });

  it('reads a PEM from a path', () => {
    const path = withLocal(pem);
    expect(readPrivateKey(load({}, withLocal({ kalshiPrivateKeyPath: path })))).toBe(pem);
  });

  it('treats an empty source as not configured', () => {
    const path = withLocal('');
    expect(readPrivateKey(load({}, withLocal({ kalshiPrivateKeyPath: path })))).toBeUndefined();
  });

  it('rejects a non-PEM file and an unreadable fd, naming the key', () => {
    const path = withLocal('hello');
    expect(errorOf(() => readPrivateKey(load({}, withLocal({ kalshiPrivateKeyPath: path })))).keys).toEqual([
      'kalshiPrivateKeyPath',
    ]);
    expect(errorOf(() => readPrivateKey(load({ KALSHI_PRIVATE_KEY_FD: '987654' }))).keys).toEqual([
      'KALSHI_PRIVATE_KEY_FD',
    ]);
  });
});
