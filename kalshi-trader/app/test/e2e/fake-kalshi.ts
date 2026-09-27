/**
 * A local stand-in for the Kalshi API during `npm run e2e` (never used in production): answers
 * `/trade-api/v2/*` from the recorded fixtures in `test/fixtures/kalshi/` (the same routing as the
 * `msw` unit tests). The e2e server reaches it through `KST_E2E_KALSHI_URL`, honoured only with
 * `KST_E2E=1` outside production. It also stands in for the NHL Web API under `/nhl/v1/*`
 * (`test/fixtures/nhl/`, reached through `KST_E2E_NHL_URL`, T07), for API-Football under `/api-football/*`
 * (`test/fixtures/api-football/`, `KST_E2E_API_FOOTBALL_URL`, T15) and for the Supervisor's Core API
 * under `/supervisor/core/api/*` (`KST_E2E_SUPERVISOR_URL`, T15), so no e2e request leaves the machine.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { API_PREFIX, routeKalshi } from '../helpers/kalshiFixtures.js';
import { NHL_PREFIX, routeNhl } from '../helpers/nhlFixtures.js';

const port = Number(process.env['E2E_KALSHI_PORT'] ?? 8197);
const API_FOOTBALL_LIVE = readFileSync(
  resolve(import.meta.dirname, '../fixtures/api-football/fixtures-live.json'),
  'utf8',
);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  req.resume();
  req.on('end', () => {
    const signed = typeof req.headers['kalshi-access-signature'] === 'string';
    if (url.pathname.startsWith('/api-football/')) {
      const body =
        url.pathname === '/api-football/status'
          ? JSON.stringify({ errors: [], response: { subscription: { plan: 'Free' } } })
          : API_FOOTBALL_LIVE;
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    if (url.pathname.startsWith('/supervisor/core/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
      return;
    }
    if (url.pathname.startsWith(NHL_PREFIX)) {
      const n = routeNhl(url.pathname.slice(NHL_PREFIX.length));
      res.writeHead(n.status, { 'content-type': 'application/json' }).end(JSON.stringify(n.body));
      return;
    }
    const path = url.pathname.slice(API_PREFIX.length);
    const r = url.pathname.startsWith(API_PREFIX)
      ? signed
        ? routeKalshi(req.method ?? 'GET', path, url.searchParams)
        : { status: 401, body: { error: { code: 'unauthorized', message: 'missing signature' } } }
      : { status: 404, body: { error: { code: 'not_found' } } };
    // T09: `GET /markets/{ticker}` answers for the requested ticker and stays open for another day, so the
    // executor's dry-run fills in the e2e replay pass the market guard whatever the date.
    const market = /^\/markets\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && market && r.status === 200) {
      const body = r.body as { market: Record<string, unknown> };
      body.market['ticker'] = decodeURIComponent(market[1] ?? '');
      body.market['close_time'] = new Date(Date.now() + 86_400_000).toISOString();
    }
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
  });
}).listen(port, '127.0.0.1');
