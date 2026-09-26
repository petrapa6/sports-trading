import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePrivateKeyFd, loadConfig, readPrivateKey } from '../../src/config.js';
import { publicKeyFingerprint } from '../../src/server/routes/dev.js';
import { createTestApp } from '../helpers/app.js';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kst-key-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const isOpen = (fd: number) => {
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

describe('private key hand-over on a file descriptor (SPEC.md §11 run.sh)', () => {
  it('reads the key and keeps the descriptor open until closePrivateKeyFd, which closes it once', () => {
    const path = join(dir, 'key');
    writeFileSync(path, pem);
    const fd = openSync(path, 'r');
    const { config } = loadConfig({
      env: { KALSHI_PRIVATE_KEY_FD: String(fd), CONFIG_LOCAL_PATH: join(dir, 'none.json') },
    });

    expect(readPrivateKey(config, { closeFd: false })).toBe(pem);
    expect(isOpen(fd)).toBe(true);

    closePrivateKeyFd(config);
    expect(isOpen(fd)).toBe(false);

    // The kernel hands the freed number to the next open file; a second close must not touch it.
    const reused = openSync(path, 'r');
    closePrivateKeyFd(config);
    expect(isOpen(reused)).toBe(true);
    closeSync(reused);
  });

  it('closes the descriptor right away by default', () => {
    const path = join(dir, 'key');
    writeFileSync(path, pem);
    const fd = openSync(path, 'r');
    const { config } = loadConfig({
      env: { KALSHI_PRIVATE_KEY_FD: String(fd), CONFIG_LOCAL_PATH: join(dir, 'none.json') },
    });
    expect(readPrivateKey(config)).toBe(pem);
    expect(isOpen(fd)).toBe(false);
  });
});

describe('--kalshi-private-key-fd (run.sh keeps KALSHI_PRIVATE* out of the environment)', () => {
  it('sets the descriptor from the argument, which wins over KALSHI_PRIVATE_KEY_FD', () => {
    const none = join(dir, 'none.json');
    expect(
      loadConfig({ env: { CONFIG_LOCAL_PATH: none }, argv: ['--kalshi-private-key-fd=3'] }).config,
    ).toMatchObject({
      kalshiPrivateKeyFd: 3,
    });
    expect(
      loadConfig({
        env: { CONFIG_LOCAL_PATH: none, KALSHI_PRIVATE_KEY_FD: '4' },
        argv: ['--kalshi-private-key-fd=5'],
      }).config.kalshiPrivateKeyFd,
    ).toBe(5);
    expect(
      loadConfig({ env: { CONFIG_LOCAL_PATH: none }, argv: [] }).config.kalshiPrivateKeyFd,
    ).toBeUndefined();
  });

  it('fails fast naming the argument when it is not an integer', () => {
    expect(() =>
      loadConfig({ env: { CONFIG_LOCAL_PATH: join(dir, 'none.json') }, argv: ['--kalshi-private-key-fd=x'] }),
    ).toThrow(/--kalshi-private-key-fd/);
  });
});

describe('publicKeyFingerprint', () => {
  it('equals `openssl pkey -in key.pem -pubout | sha256sum`', () => {
    const path = join(dir, 'key.pem');
    writeFileSync(path, pem);
    const pub = spawnSync('openssl', ['pkey', '-in', path, '-pubout']);
    if (pub.status !== 0) return; // openssl not installed: the container check in verify:T05 covers it
    const sum = spawnSync('sha256sum', { input: pub.stdout, encoding: 'utf8' });
    expect(publicKeyFingerprint(pem)).toBe(sum.stdout.split(' ')[0]);
  });
});

describe('GET /api/dev/key-fingerprint', () => {
  it('exists only with NODE_ENV=development and only for loopback (class dev)', async () => {
    const fingerprint = publicKeyFingerprint(pem);
    const dev = await createTestApp({ nodeEnv: 'development', privateKeyFingerprint: fingerprint });
    const prod = await createTestApp({ nodeEnv: 'production', privateKeyFingerprint: fingerprint });
    try {
      const ok = await dev.app.inject({ url: '/api/dev/key-fingerprint', remoteAddress: '127.0.0.1' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ loaded: true, sha256: fingerprint });

      const remote = await dev.app.inject({ url: '/api/dev/key-fingerprint', remoteAddress: '10.0.0.9' });
      expect(remote.statusCode).toBe(404);

      const inProd = await prod.app.inject({ url: '/api/dev/key-fingerprint', remoteAddress: '127.0.0.1' });
      expect(inProd.statusCode).not.toBe(200);
      expect(inProd.body).not.toContain(fingerprint);
    } finally {
      await dev.close();
      await prod.close();
    }
  });
});
