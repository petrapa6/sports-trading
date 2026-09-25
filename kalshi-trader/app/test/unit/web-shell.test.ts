import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IMMUTABLE, renderShell, SPA_ROUTES } from '../../src/server/web.js';
import {
  Client,
  createTestApp,
  ingress,
  INGRESS_PATH,
  PASSWORD,
  setupUser,
  tunnel,
  USER,
  type TestApp,
} from '../helpers/app.js';

/** A stand-in for the Vite build (`dist/web`), shaped like the real `index.html`. */
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <base href="/" />
    <link rel="icon" href="data:," />
    <script type="module" crossorigin src="./assets/index-P4Uw_MZI.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-DX0_u1oP.css">
  </head>
  <body><div id="root"></div></body>
</html>
`;

let webDir: string;
let t: TestApp;

beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), 'kst-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), TEMPLATE);
  writeFileSync(join(webDir, 'assets', 'index-P4Uw_MZI.js'), 'console.log(1);\n');
  writeFileSync(join(webDir, 'assets', 'index-DX0_u1oP.css'), 'body{}\n');
  writeFileSync(join(webDir, 'assets', 'unhashed.js'), '\n');
});
afterAll(() => rmSync(webDir, { recursive: true, force: true }));
afterEach(async () => t?.close());

describe('renderShell', () => {
  it('rewrites <base href> and ./ asset URLs to the prefix', () => {
    const html = renderShell(TEMPLATE, INGRESS_PATH);
    expect(html).toContain(`<base href="${INGRESS_PATH}/">`);
    expect(html).toContain(`src="${INGRESS_PATH}/assets/index-P4Uw_MZI.js"`);
    expect(html).toContain(`href="${INGRESS_PATH}/assets/index-DX0_u1oP.css"`);
    expect(html).not.toContain('"./');
    expect(renderShell(TEMPLATE, '')).toContain('<base href="/">');
    expect(renderShell(TEMPLATE, '')).toContain('src="/assets/index-P4Uw_MZI.js"');
  });
});

describe('serving the web build', () => {
  it('GET / → 200 text/html for a non-browser client; a browser without a session is sent to /login', async () => {
    t = await createTestApp({ webDir });
    const c = new Client(t.app, tunnel());
    const head = await c.request('HEAD', '/');
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toMatch(/^text\/html/);
    expect(head.headers['cache-control']).toBe('no-store');
    const nav = await c.get('/settings/account', { headers: { accept: 'text/html' } });
    expect(nav.statusCode).toBe(303);
    expect(nav.headers.location).toBe('/login');
    // The shell has no inline script or style (CSP) and no app data.
    const shell = await c.get('/login');
    expect(shell.statusCode).toBe(200);
    expect(shell.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(shell.body).not.toMatch(/<style|style=/i);
    expect(shell.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('every client route serves the shell once signed in', async () => {
    t = await createTestApp({ webDir });
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    await c.login(USER, PASSWORD);
    for (const route of SPA_ROUTES) {
      const res = await c.get(route, { headers: { accept: 'text/html' } });
      expect(res.statusCode, route).toBe(200);
      expect(res.body).toContain('<base href="/">');
    }
    expect((await c.get('/nope', { headers: { accept: 'text/html' } })).statusCode).toBe(404);
  });

  it('ingress: <base href> and asset URLs start with the ingress path', async () => {
    t = await createTestApp({ webDir });
    const res = await new Client(t.app, ingress()).get('/login');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<base href="${INGRESS_PATH}/">`);
    const urls = [...res.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
    const assets = urls.filter((u) => !u.startsWith('data:'));
    expect(assets.length).toBeGreaterThanOrEqual(3);
    for (const u of assets) expect(u.startsWith(`${INGRESS_PATH}/`), u).toBe(true);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('hashed assets are cached for a year; other assets are revalidated', async () => {
    t = await createTestApp({ webDir });
    const c = new Client(t.app, tunnel());
    const js = await c.get('/assets/index-P4Uw_MZI.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toBe(IMMUTABLE);
    expect((await c.get('/assets/index-DX0_u1oP.css')).headers['cache-control']).toBe(IMMUTABLE);
    expect((await c.get('/assets/unhashed.js')).headers['cache-control']).toBe('no-cache');
    // The no-JavaScript fallback stylesheet is still served.
    const css = await c.get('/assets/auth.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['cache-control']).toBe('no-cache');
  });

  it('/setup keeps its gate: tunnel → 403, ingress → shell, after setup → 410', async () => {
    t = await createTestApp({ webDir });
    expect((await new Client(t.app, tunnel()).get('/setup')).statusCode).toBe(403);
    expect((await new Client(t.app, ingress()).get('/setup')).statusCode).toBe(200);
    await setupUser(t.app);
    expect((await new Client(t.app, ingress()).get('/setup')).statusCode).toBe(410);
  });

  it('/auth/state tells the login page whether setup is due and possible here', async () => {
    t = await createTestApp({ webDir });
    expect((await new Client(t.app, ingress()).get('/auth/state')).json()).toEqual({
      needsSetup: true,
      setupAllowed: true,
    });
    expect((await new Client(t.app, tunnel()).get('/auth/state')).json()).toEqual({
      needsSetup: true,
      setupAllowed: false,
    });
    await setupUser(t.app);
    expect((await new Client(t.app, ingress()).get('/auth/state')).json()).toMatchObject({
      needsSetup: false,
    });
  });
});
