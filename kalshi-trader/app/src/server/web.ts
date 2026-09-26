import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendHtml, wantsHtml } from './http.js';
import { homePage, loginPage, setupPage } from './pages.js';
import { setupGate } from './routes/auth.js';
import { authOf, basePath, type RateLimits } from './security.js';

/** Static assets that are not part of the web build (the no-JavaScript login/setup fallback). */
export const PUBLIC_DIR = resolve(import.meta.dirname, '../../public');
/** `npm run build` output of the React app (resolves to `dist/web` from both `src/server` and `dist/server`). */
export const WEB_DIR = resolve(import.meta.dirname, '../../dist/web');

/** Client-side routes of the React app; each serves the same HTML shell. */
export const SPA_ROUTES = [
  '/',
  '/strategies',
  '/trades',
  '/backtest',
  '/settings',
  '/settings/trading',
  '/settings/account',
  '/settings/leagues',
  '/settings/feeds',
  '/settings/data',
  '/settings/diagnostics',
] as const;

/** Vite names hashed files `<name>-<8 base64url chars>.<ext>`; those never change and are cached for a year. */
const HASHED = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * The HTML shell for a request: `<base href>` and every `./` asset URL become absolute under the
 * browser-facing prefix (`X-Ingress-Path` for ingress, `/` otherwise), so the app works both at
 * the root and inside the Home Assistant ingress iframe.
 */
export function renderShell(template: string, prefix: string): string {
  return template
    .replace(/<base href="[^"]*"\s*\/?>/, `<base href="${prefix}/">`)
    .replace(/(src|href)="\.\//g, `$1="${prefix}/`);
}

/**
 * Serves the React app from `webDir` (the Vite build): hashed assets under `/assets/`, the HTML
 * shell for `/login`, `/setup` and every client route. The shell carries no app data, so it is
 * public; a browser navigation without a session is still redirected to `/login` before any page
 * renders. Without a build (unit tests, a fresh checkout) the minimal server-rendered pages from
 * T03 are served instead.
 */
export async function registerWeb(app: FastifyInstance, webDir: string, limits: RateLimits): Promise<void> {
  const loginConfig = { public: true, rateLimit: { max: limits.login, timeWindow: 60_000 } };
  const indexPath = resolve(webDir, 'index.html');
  const spa = existsSync(indexPath);
  const webAssets = resolve(webDir, 'assets');
  const roots = [webAssets, resolve(PUBLIC_DIR, 'assets')].filter((d) => existsSync(d));

  if (roots.length > 0) {
    await app.register(fastifyStatic, {
      root: roots,
      prefix: '/assets/',
      index: false,
      list: false,
      dotfiles: 'deny',
      decorateReply: false,
      cacheControl: false,
      setHeaders: (res, path) => {
        res.header('cache-control', path.startsWith(webAssets) && HASHED.test(path) ? IMMUTABLE : 'no-cache');
      },
    });
  }

  if (!spa) {
    app.log.debug({ webDir }, 'No web build found; serving the minimal server-rendered pages');
    app.get('/login', { config: loginConfig }, async (_req, reply) =>
      sendHtml(reply, 200, loginPage({ noUser: app.authService.userCount() === 0 })),
    );
    app.get('/setup', { config: { public: true } }, async (req, reply) => {
      setupGate(app, req);
      return sendHtml(reply, 200, setupPage({}));
    });
    app.get('/', async (req, reply) => {
      const { user } = authOf(req);
      return sendHtml(
        reply,
        200,
        homePage({ username: user.username, csrfToken: app.csrfToken(req, reply) }),
      );
    });
    return;
  }

  // Re-read on every request: the file is small and a rebuild then shows up without a restart.
  const shell = (req: FastifyRequest) => renderShell(readFileSync(indexPath, 'utf8'), basePath(req));

  app.get('/login', { config: loginConfig }, async (req, reply) => sendHtml(reply, 200, shell(req)));
  app.get('/setup', { config: { public: true } }, async (req, reply) => {
    setupGate(app, req);
    return sendHtml(reply, 200, shell(req));
  });
  for (const route of SPA_ROUTES) {
    app.get(route, { config: { public: true } }, async (req, reply) => {
      if (wantsHtml(req) && !app.optionalAuth(req)) return reply.redirect(`${basePath(req)}/login`, 303);
      return sendHtml(reply, 200, shell(req));
    });
  }
}
