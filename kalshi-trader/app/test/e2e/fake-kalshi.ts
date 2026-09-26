/**
 * A local stand-in for the Kalshi API during `npm run e2e` (never used in production): answers
 * `/trade-api/v2/*` from the recorded fixtures in `test/fixtures/kalshi/` (the same routing as the
 * `msw` unit tests). The e2e server reaches it through `KST_E2E_KALSHI_URL`, honoured only with
 * `KST_E2E=1` outside production. It also stands in for the NHL Web API under `/nhl/v1/*`
 * (`test/fixtures/nhl/`, reached through `KST_E2E_NHL_URL`, T07).
 */
import { createServer } from 'node:http';
import { API_PREFIX, routeKalshi } from '../helpers/kalshiFixtures.js';
import { NHL_PREFIX, routeNhl } from '../helpers/nhlFixtures.js';

const port = Number(process.env['E2E_KALSHI_PORT'] ?? 8197);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  req.resume();
  req.on('end', () => {
    const signed = typeof req.headers['kalshi-access-signature'] === 'string';
    if (url.pathname.startsWith(NHL_PREFIX)) {
      const n = routeNhl(url.pathname.slice(NHL_PREFIX.length));
      res.writeHead(n.status, { 'content-type': 'application/json' }).end(JSON.stringify(n.body));
      return;
    }
    const r = url.pathname.startsWith(API_PREFIX)
      ? signed
        ? routeKalshi(req.method ?? 'GET', url.pathname.slice(API_PREFIX.length), url.searchParams)
        : { status: 401, body: { error: { code: 'unauthorized', message: 'missing signature' } } }
      : { status: 404, body: { error: { code: 'not_found' } } };
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
  });
}).listen(port, '127.0.0.1');
