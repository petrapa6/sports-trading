import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Writable } from 'node:stream';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { setupServer } from 'msw/node';
import { pino, type Logger } from 'pino';
import { KalshiClient, type KalshiClientOptions } from '../../src/feeds/kalshi/client.js';
import { createNetworkGate } from '../../src/feeds/network.js';
import { API_PREFIX, routeKalshi } from './kalshiFixtures.js';

export const TEST_BASE = 'https://kalshi.test/trade-api/v2';
export const TEST_KEY_ID = 'a1b2c3d4-key-id-not-for-logs-e5f6';

/** A per-run RSA key (never committed): the "fixture key". */
export const fixtureKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey,
    publicKey,
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
})() as { privateKey: KeyObject; publicKey: KeyObject; pem: string };

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

/** An msw server answering every Kalshi path from the fixtures; `requests` records what reached it. */
export function kalshiMockServer() {
  const requests: Recorded[] = [];
  const handler = http.all(`${TEST_BASE}/*`, async ({ request }) => {
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      url,
      headers: request.headers,
      body: await request.clone().text(),
    });
    const r = routeKalshi(request.method, url.pathname.slice(API_PREFIX.length), url.searchParams);
    return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status });
  });
  const server = setupServer(handler);
  /** Every request msw saw (including ones answered by per-test handlers). */
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(`${request.method} ${request.url}`);
  });
  return {
    server,
    requests,
    seen,
    /** Prepends handlers for one test (reset in `afterEach` with `server.resetHandlers()`). */
    use: (...handlers: HttpHandler[]) => server.use(...handlers),
  };
}

/** Captured Pino output. */
export function captureLogger(level = 'debug'): { log: Logger; text: () => string } {
  let out = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  return { log: pino({ level }, sink), text: () => out };
}

export function testClient(
  overrides: Partial<KalshiClientOptions> & { killSwitch?: () => boolean } = {},
): KalshiClient {
  const { killSwitch, ...rest } = overrides;
  return new KalshiClient({
    env: 'demo',
    keyId: TEST_KEY_ID,
    privateKey: fixtureKey.pem,
    subaccount: 0,
    gate: createNetworkGate(killSwitch ?? (() => false)),
    log: captureLogger().log,
    baseUrl: TEST_BASE,
    ...rest,
  });
}

/** The value, or a thrown error when it is `null` / `undefined` (tests avoid non-null assertions). */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}
