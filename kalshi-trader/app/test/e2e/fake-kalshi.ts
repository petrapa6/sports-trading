/**
 * A local stand-in for the Kalshi API during `npm run e2e` (never used in production): answers
 * `/trade-api/v2/*` from the recorded fixtures in `test/fixtures/kalshi/` (the same routing as the
 * `msw` unit tests). The e2e server reaches it through `KST_E2E_KALSHI_URL`, honoured only with
 * `KST_E2E=1` outside production.
 */
import { createServer } from 'node:http';
import { API_PREFIX, routeKalshi } from '../helpers/kalshiFixtures.js';

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
    const r = url.pathname.startsWith(API_PREFIX)
      ? signed
        ? routeKalshi(req.method ?? 'GET', url.pathname.slice(API_PREFIX.length), url.searchParams)
        : { status: 401, body: { error: { code: 'unauthorized', message: 'missing signature' } } }
      : { status: 404, body: { error: { code: 'not_found' } } };
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
  });
}).listen(port, '127.0.0.1');
