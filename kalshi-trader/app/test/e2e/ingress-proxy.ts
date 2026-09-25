/**
 * A stand-in for the Home Assistant Supervisor ingress proxy, for the e2e suite: requests to
 * `/api/hassio_ingress/abc/<path>` are forwarded to the app as `/<path>` with `X-Ingress-Path`,
 * `X-Forwarded-For` and `X-Forwarded-Proto: http`, like the Supervisor does. The app runs with
 * `KST_E2E=1`, so the loopback peer counts as the ingress proxy. Streams (SSE) are piped through.
 */
import { createServer, request } from 'node:http';

export const INGRESS_PATH = '/api/hassio_ingress/abc';
const target = Number(process.env['E2E_PORT'] ?? 8198);
const port = Number(process.env['E2E_PROXY_PORT'] ?? 8199);

createServer((req, res) => {
  const url = req.url ?? '/';
  if (url !== INGRESS_PATH && !url.startsWith(`${INGRESS_PATH}/`) && !url.startsWith(`${INGRESS_PATH}?`)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not an ingress path');
    return;
  }
  const path = url.slice(INGRESS_PATH.length) || '/';
  const headers = { ...req.headers };
  delete headers['cf-connecting-ip'];
  headers['x-ingress-path'] = INGRESS_PATH;
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? '127.0.0.1';
  headers['x-forwarded-proto'] = 'http';
  headers['host'] = `127.0.0.1:${target}`;
  const upstream = request({ host: '127.0.0.1', port: target, method: req.method, path, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
  res.on('close', () => upstream.destroy());
}).listen(port, '127.0.0.1');
