import type { IncomingMessage } from 'node:http';
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
  preHandlerHookHandler,
} from 'fastify';
import type { Session, User } from '../db/schema.js';
import { ABSOLUTE_LIFETIME_MS, STEP_UP_MS, type AuthService, type ClientContext } from './auth/service.js';
import { HttpError, wantsHtml } from './http.js';
import { createClassifier, type Classification, type ClassifierOptions } from './requestClass.js';
import { deriveKey } from './secrets.js';

export interface AuthState {
  session: Session;
  user: User;
}

declare module 'fastify' {
  interface FastifyRequest {
    client: Classification;
    auth: AuthState | null;
  }
  interface FastifyContextConfig {
    /** Reachable without a session (`/login`, `/setup`, `/healthz`, static assets). */
    public?: boolean;
  }
  interface FastifyInstance {
    authService: AuthService;
    /** Step-up: a preHandler rejecting with `403 reauth_required` unless the session authenticated recently. */
    requireRecentAuth(maxAgeMs?: number): preHandlerAsyncHookHandler;
    issueSession(req: FastifyRequest, reply: FastifyReply, user: User): void;
    /** The request's session on a public route (where the session hook does not run), if valid. */
    optionalAuth(req: FastifyRequest): AuthState | undefined;
    clearSession(req: FastifyRequest, reply: FastifyReply): void;
    csrfToken(req: FastifyRequest, reply: FastifyReply): string;
  }
}

export interface RateLimits {
  /** Requests per minute per client IP for every non-exempt route. */
  global: number;
  /** Requests per minute per client IP for `/login`. */
  login: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { global: 300, login: 5 };

export interface SecurityOptions extends ClassifierOptions {
  secretKey: Buffer;
  authService: AuthService;
  rateLimits?: RateLimits;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ASSET_PREFIX = '/assets/';
/** Exempt from the global rate limit: static assets and the SSE stream (T04). */
const RATE_LIMIT_EXEMPT = (path: string): boolean => path.startsWith(ASSET_PREFIX) || path === '/api/live';

export const clientContext = (req: FastifyRequest): ClientContext => ({
  ip: req.client.clientIp,
  channel: req.client.class,
});

export const sessionCookieName = (c: Classification): string =>
  c.class === 'ingress' ? 'kst_session_ingress' : 'kst_session';

/** Per-channel cookie attributes (SPEC.md §10 Login and sessions). */
export const cookieAttributes = (c: Classification) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  path: c.ingressPath ?? '/',
  secure: c.secure,
});

/** The signed-in session of a non-public route (set by the session hook). */
export function authOf(req: FastifyRequest): AuthState {
  if (!req.auth) throw new HttpError(401, 'unauthorized');
  return req.auth;
}

/** The base path the browser sees: the ingress prefix, or empty. */
export const basePath = (req: FastifyRequest): string => req.client.ingressPath ?? '';

/**
 * Registers every §10 control on the root instance: request classification, helmet (CSP and
 * per-class framing), rate limits, signed cookies, server-side sessions, CSRF and step-up.
 * Must be awaited before any route is registered.
 */
export async function registerSecurity(app: FastifyInstance, options: SecurityOptions): Promise<void> {
  const classify = createClassifier(options);
  const auth = options.authService;
  const limits = options.rateLimits ?? DEFAULT_RATE_LIMITS;
  const classes = new WeakMap<IncomingMessage, Classification>();

  app.decorate('authService', auth);
  app.decorateRequest('client', null as unknown as Classification);
  app.decorateRequest('auth', null);

  // 1. Classification, before anything else runs (helmet reads it for frame-ancestors).
  app.addHook('onRequest', (req, reply, done) => {
    const c = classify(req.socket.remoteAddress, req.headers);
    req.client = c;
    classes.set(req.raw, c);
    reply.header('x-frame-options', c.class === 'ingress' ? 'SAMEORIGIN' : 'DENY');
    if (c.class === 'tunnel') reply.header('strict-transport-security', 'max-age=31536000');
    done();
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: [(req) => (classes.get(req)?.class === 'ingress' ? "'self'" : "'none'")],
      },
    },
    // Set per class in the classification hook instead.
    frameguard: false,
    hsts: false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  await app.register(rateLimit, {
    global: true,
    max: limits.global,
    timeWindow: 60_000,
    keyGenerator: (req) => req.client.clientIp,
    allowList: (req) => RATE_LIMIT_EXEMPT(req.url.split('?')[0] ?? ''),
    errorResponseBuilder: (_req, ctx) =>
      new HttpError(429, 'rate_limited', { retryAfterSeconds: Math.ceil(ctx.ttl / 1000) }),
  });

  await app.register(cookie, { secret: deriveKey(options.secretKey, 'cookie') });

  await app.register(csrf, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: 'kst_csrf',
    cookieOpts: { httpOnly: true, sameSite: 'strict', path: '/', signed: true },
    csrfOpts: { hmacKey: deriveKey(options.secretKey, 'csrf') },
    // Tokens are bound to the session, so a token from one session is useless in another.
    getUserInfo: (req) => req.auth?.session.id_hash ?? '',
  });

  const readSessionId = (req: FastifyRequest): string | undefined => {
    const raw = req.cookies[sessionCookieName(req.client)];
    if (!raw) return undefined;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? unsigned.value : undefined;
  };

  app.decorate('issueSession', (req: FastifyRequest, reply: FastifyReply, user: User) => {
    // Rotation: whatever session the browser presented is dropped and a new id is issued.
    const previous = readSessionId(req);
    if (previous !== undefined) {
      const resolved = auth.resolveSession(previous, req.client.class);
      if (resolved) auth.deleteSession(resolved.session.id_hash);
    }
    const { id, session } = auth.createSession(user, clientContext(req), req.headers['user-agent']);
    req.auth = { session, user };
    reply.setCookie(sessionCookieName(req.client), id, {
      ...cookieAttributes(req.client),
      signed: true,
      maxAge: ABSOLUTE_LIFETIME_MS / 1000,
    });
  });

  app.decorate('optionalAuth', (req: FastifyRequest): AuthState | undefined => {
    if (req.auth) return req.auth;
    const id = readSessionId(req);
    if (id === undefined) return undefined;
    try {
      return auth.resolveSession(id, req.client.class);
    } catch {
      return undefined; // database unavailable: treated as signed out
    }
  });

  app.decorate('clearSession', (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth) auth.deleteSession(req.auth.session.id_hash);
    reply.clearCookie(sessionCookieName(req.client), cookieAttributes(req.client));
  });

  app.decorate('csrfToken', (req: FastifyRequest, reply: FastifyReply) =>
    reply.generateCsrf({
      ...cookieAttributes(req.client),
      userInfo: req.auth?.session.id_hash ?? '',
    } as Parameters<FastifyReply['generateCsrf']>[0]),
  );

  app.decorate('requireRecentAuth', (maxAgeMs: number = STEP_UP_MS): preHandlerAsyncHookHandler => {
    return async (req, reply) => {
      if (!req.auth || !auth.isRecentAuth(req.auth.session, maxAgeMs)) {
        return reply.code(403).send({ error: 'reauth_required' });
      }
    };
  });

  // 2. Session check on every non-public route, after the rate limiter (both are route-level
  //    onRequest hooks; the rate limiter's onRoute hook was registered first).
  const authenticate: onRequestAsyncHookHandler = async (req, reply) => {
    const id = readSessionId(req);
    const resolved = id !== undefined ? auth.resolveSession(id, req.client.class) : undefined;
    if (resolved) {
      req.auth = resolved;
      return;
    }
    if (wantsHtml(req)) return reply.redirect(`${basePath(req)}/login`, 303);
    return reply.code(401).send({ error: 'unauthorized' });
  };

  // 3. CSRF token on every state-changing request of a signed-in session.
  const csrfCheck: preHandlerHookHandler = (req, reply, done) => {
    if (SAFE_METHODS.has(req.method)) return done();
    app.csrfProtection(req, reply, done);
  };

  app.addHook('onRoute', (route) => {
    const isPublic = route.config?.public === true || route.url.startsWith(ASSET_PREFIX);
    if (isPublic) {
      route.config = { ...route.config, public: true };
      return;
    }
    route.onRequest = [...toArray(route.onRequest), authenticate];
    route.preHandler = [csrfCheck, ...toArray(route.preHandler)];
  });
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
