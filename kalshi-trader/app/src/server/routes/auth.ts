import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { normaliseUsername, type LoginResult } from '../auth/service.js';
import { HttpError, isFormPost, parseBody, sendHtml } from '../http.js';
import { homePage, loginPage, setupPage } from '../pages.js';
import { authOf, clientContext, cookieAttributes, sessionCookieName, type RateLimits } from '../security.js';

/** Form fields arrive as empty strings when left blank. */
const optionalField = (max: number) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().max(max).optional());

const LoginBody = z
  .object({
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(1024),
    totp: optionalField(16),
    recoveryCode: optionalField(64),
  })
  .strict();

const NewPassword = z.string().min(12, 'must be at least 12 characters').max(1024);

const SetupBody = z
  .object({
    username: z
      .string()
      .transform(normaliseUsername)
      .pipe(z.string().regex(/^[a-z0-9._-]{1,64}$/, 'use 1–64 letters, digits, dots, dashes or underscores')),
    password: NewPassword,
  })
  .strict();

const ReauthBody = z.object({ password: z.string().min(1).max(1024) }).strict();
const PasswordBody = z.object({ newPassword: NewPassword }).strict();
const CodeBody = z.object({ code: z.string().min(1).max(16) }).strict();
const FormCsrfBody = z.object({ _csrf: z.string().optional() }).strict();

const LOGIN_MESSAGES: Record<Exclude<LoginResult, { ok: true }>['error'], string> = {
  invalid_credentials: 'Wrong username or password.',
  totp_required: 'Enter the code from your authenticator app (and your password again).',
  locked_out: 'Too many failed attempts. Try again later.',
};

/** `/login`, `/setup`, `/`, and the `/auth/*` session, step-up, password and TOTP endpoints. */
export function registerAuthRoutes(app: FastifyInstance, limits: RateLimits): void {
  const auth = app.authService;
  const loginConfig = { public: true, rateLimit: { max: limits.login, timeWindow: 60_000 } };

  const sendLoginFailure = (
    reply: FastifyReply,
    result: Exclude<LoginResult, { ok: true }>,
    form: boolean,
    username: string,
  ) => {
    const status = result.error === 'locked_out' ? 429 : 401;
    if (result.error === 'locked_out') reply.header('retry-after', String(result.retryAfterSeconds));
    if (form) {
      return sendHtml(
        reply,
        status,
        loginPage({ error: LOGIN_MESSAGES[result.error], username, totp: result.error === 'totp_required' }),
      );
    }
    return reply
      .code(status)
      .send(
        result.error === 'locked_out'
          ? { error: result.error, retryAfterSeconds: result.retryAfterSeconds }
          : { error: result.error },
      );
  };

  app.get('/login', { config: loginConfig }, async (_req, reply) =>
    sendHtml(reply, 200, loginPage({ noUser: auth.userCount() === 0 })),
  );

  app.post('/login', { config: loginConfig }, async (req, reply) => {
    const form = isFormPost(req);
    const body = parseBody(LoginBody, req.body);
    const result = await auth.login(body, clientContext(req));
    if (!result.ok) return sendLoginFailure(reply, result, form, body.username);
    app.issueSession(req, reply, result.user);
    if (form) return reply.redirect('./', 303);
    return { ok: true, username: result.user.username };
  });

  // First-run setup: only while `users` is empty, only via ingress (or dev).
  const setupGate = (req: { client: { class: string } }) => {
    if (req.client.class !== 'ingress' && req.client.class !== 'dev') throw new HttpError(403, 'forbidden');
    if (auth.userCount() > 0) throw new HttpError(410, 'gone');
  };

  app.get('/setup', { config: { public: true } }, async (req, reply) => {
    setupGate(req);
    return sendHtml(reply, 200, setupPage({}));
  });

  app.post('/setup', { config: { public: true } }, async (req, reply) => {
    setupGate(req);
    const form = isFormPost(req);
    const parsed = SetupBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`);
      if (form) {
        const raw = (req.body ?? {}) as Record<string, unknown>;
        return sendHtml(
          reply,
          400,
          setupPage({
            error: issues.join('; '),
            username: typeof raw['username'] === 'string' ? raw['username'] : '',
          }),
        );
      }
      throw new HttpError(400, 'bad_request', { issues });
    }
    const user = await auth.createUser(parsed.data.username, parsed.data.password, clientContext(req));
    app.issueSession(req, reply, user);
    if (form) return reply.redirect('./', 303);
    return reply.code(201).send({ ok: true, username: user.username });
  });

  // Signed-in placeholder until the React shell (T04).
  app.get('/', async (req, reply) => {
    const { user } = authOf(req);
    return sendHtml(reply, 200, homePage({ username: user.username, csrfToken: app.csrfToken(req, reply) }));
  });

  app.post('/auth/logout', async (req, reply) => {
    parseBody(FormCsrfBody, req.body);
    const { user, session } = authOf(req);
    auth.audit(
      { actor: `user:${user.username}`, ...clientContext(req) },
      { action: 'logout', entity: 'session', entityId: session.id_hash.slice(0, 16) },
    );
    app.clearSession(req, reply);
    if (isFormPost(req)) return reply.redirect('../login', 303);
    return { ok: true };
  });

  app.post('/auth/reauth', async (req, reply) => {
    const body = parseBody(ReauthBody, req.body);
    const { user, session } = authOf(req);
    const result = await auth.reauth(session, user, body.password, clientContext(req));
    if (!result.ok) return sendLoginFailure(reply, result, false, user.username);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const { user, session } = authOf(req);
    return {
      username: user.username,
      totpEnabled: user.totp_secret_enc !== null,
      recoveryCodesRemaining: user.recovery_codes_hash
        ? (JSON.parse(user.recovery_codes_hash) as unknown[]).length
        : 0,
      channel: session.channel,
      lastAuthAt: session.last_auth_at,
      reauthRequired: !auth.isRecentAuth(session),
    };
  });

  app.post('/auth/password', { preHandler: app.requireRecentAuth() }, async (req) => {
    const body = parseBody(PasswordBody, req.body);
    const { user, session } = authOf(req);
    await auth.changePassword(user, body.newPassword, session, clientContext(req));
    return { ok: true };
  });

  app.get('/auth/sessions', async (req) => {
    const { user, session } = authOf(req);
    return {
      sessions: auth.listSessions(user.id).map((s) => ({
        id: s.id_hash,
        channel: s.channel,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
        ip: s.ip,
        ua: s.ua,
        current: s.id_hash === session.id_hash,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/auth/sessions/:id/revoke', async (req, reply) => {
    const { user, session } = authOf(req);
    const target = auth.listSessions(user.id).find((s) => s.id_hash === req.params.id);
    if (!target) throw new HttpError(404, 'not_found');
    auth.deleteSession(target.id_hash);
    auth.audit(
      { actor: `user:${user.username}`, ...clientContext(req) },
      {
        action: 'session_revoke',
        entity: 'session',
        entityId: target.id_hash.slice(0, 16),
        detail: { channel: target.channel },
      },
    );
    if (target.id_hash === session.id_hash) {
      reply.clearCookie(sessionCookieName(req.client), cookieAttributes(req.client));
    }
    return { ok: true };
  });

  app.post('/auth/totp/enrol', { preHandler: app.requireRecentAuth() }, async (req) => {
    parseBody(z.object({}).strict(), req.body);
    const { user } = authOf(req);
    if (user.totp_secret_enc !== null) throw new HttpError(409, 'totp_already_enabled');
    const { secret, uri } = auth.startTotpEnrolment(user);
    return { otpauthUri: uri, secret };
  });

  app.post('/auth/totp/confirm', async (req) => {
    const body = parseBody(CodeBody, req.body);
    const { user } = authOf(req);
    const codes = await auth.confirmTotpEnrolment(user, body.code, clientContext(req));
    if (!codes) throw new HttpError(400, 'invalid_code');
    return { recoveryCodes: codes };
  });

  app.post('/auth/totp/disable', { preHandler: app.requireRecentAuth() }, async (req) => {
    parseBody(z.object({}).strict(), req.body);
    const { user } = authOf(req);
    auth.disableTotp(user, clientContext(req));
    return { ok: true };
  });
}
