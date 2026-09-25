import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS } from '../../src/server/auth/service.js';
import { Client, createTestApp, ingress, setupUser, USER } from '../helpers/app.js';

const ITERATIONS = 200;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

describe('login timing (real argon2id cost)', () => {
  it(`unknown username vs wrong password: medians over ${ITERATIONS} iterations differ by < 20 %`, async () => {
    // Real parameters (m = 64 MiB, t = 3); ingress (no lockout) and no /login rate limit so every
    // request reaches the password check.
    const t = await createTestApp({
      argon2: ARGON2_PARAMS,
      rateLimits: { global: 1_000_000, login: 1_000_000 },
    });
    try {
      await setupUser(t.app);
      expect(t.manager.repositories.users.list()[0]?.password_hash).toMatch(
        /^\$argon2id\$v=19\$m=65536,p=\d+,t=3\$/,
      );
      const c = new Client(t.app, ingress());
      // Warm-up (the dummy hash is computed at start-up).
      await c.login('nobody', 'x');
      await c.login(USER, 'x');
      const unknown: number[] = [];
      const wrong: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        for (const [bucket, username] of i % 2
          ? ([
              [unknown, 'nobody'],
              [wrong, USER],
            ] as const)
          : ([
              [wrong, USER],
              [unknown, 'nobody'],
            ] as const)) {
          const start = performance.now();
          const res = await c.login(username, `wrong password ${i}`);
          bucket.push(performance.now() - start);
          expect(res.statusCode).toBe(401);
          expect(res.body).toBe('{"error":"invalid_credentials"}');
        }
      }
      const mu = median(unknown);
      const mw = median(wrong);
      const diff = Math.abs(mu - mw) / Math.max(mu, mw);
      console.log(
        `median unknown ${mu.toFixed(2)} ms, wrong password ${mw.toFixed(2)} ms, diff ${(diff * 100).toFixed(1)} %`,
      );
      expect(diff).toBeLessThan(0.2);
    } finally {
      await t.close();
    }
  }, 300_000);
});
