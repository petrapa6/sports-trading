import { createHash, randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { generateSecret, generateURI, verifySync } from 'otplib';
import type { Repositories } from '../../db/repositories.js';
import type { Session, User } from '../../db/schema.js';
import { userActor, writeAudit, type AuditContext, type AuditEntry } from '../audit.js';
import type { RequestClass } from '../requestClass.js';
import { decryptSetting, encryptSetting } from '../secrets.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** SPEC.md §10 Login and sessions. */
export const IDLE_TIMEOUT_MS = 12 * HOUR;
export const ABSOLUTE_LIFETIME_MS = 7 * 24 * HOUR;
export const STEP_UP_MS = 5 * MINUTE;
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_WINDOW_MS = 15 * MINUTE;
export const LOCKOUT_BASE_MS = 15 * MINUTE;
/** A lockout counts as a "repeat" (doubling the next one) when an earlier one started within this window. */
export const LOCKOUT_REPEAT_WINDOW_MS = 24 * HOUR;
export const LOCKOUT_MAX_MS = 24 * HOUR;
export const RECOVERY_CODE_COUNT = 10;
const TOTP_ENROL_TTL_MS = 10 * MINUTE;
const TOTP_ISSUER = 'Kalshi Sports Trader';

/** argon2id m = 64 MiB, t = 3 (SPEC.md §10 Secrets). Tests may pass cheaper parameters. */
export const ARGON2_PARAMS = { memoryCost: 65_536, timeCost: 3 } as const;
export type Argon2Params = { memoryCost: number; timeCost: number };

/** Classes that are subject to lockout; `ingress` (and `dev`) are only rate limited. */
export const LOCKABLE: readonly RequestClass[] = ['tunnel', 'other'];

export interface ClientContext {
  ip: string;
  channel: RequestClass;
}

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; error: 'invalid_credentials' | 'totp_required' }
  | { ok: false; error: 'locked_out'; retryAfterSeconds: number };

export interface AuthServiceOptions {
  repos: () => Repositories;
  secretKey: Buffer;
  now?: () => number;
  argon2?: Argon2Params;
}

export const hashSessionId = (id: string): string => createHash('sha256').update(id).digest('hex');

export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

interface LockoutDetail {
  until: string;
  minutes: number;
  level: number;
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function recoveryCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

const normaliseRecoveryCode = (code: string): string => code.trim().toLowerCase().replace(/\s+/g, '');

/**
 * Users, passwords, lockout, sessions, step-up and TOTP (SPEC.md §10). Stateless apart from two
 * short-lived in-memory maps (pending TOTP enrolments, last accepted TOTP time step).
 */
export class AuthService {
  readonly now: () => number;
  private readonly repos: () => Repositories;
  private readonly secretKey: Buffer;
  private readonly params: Argon2Params;
  private readonly dummyHash: Promise<string>;
  private readonly pendingTotp = new Map<number, { secret: string; expires: number }>();
  private readonly lastTotpStep = new Map<number, number>();

  constructor(options: AuthServiceOptions) {
    this.repos = options.repos;
    this.secretKey = options.secretKey;
    this.now = options.now ?? (() => Date.now());
    this.params = options.argon2 ?? ARGON2_PARAMS;
    // Verified against when the username does not exist, so both failure paths cost one argon2 verify.
    this.dummyHash = this.hashPassword(randomBytes(32).toString('base64'));
    this.dummyHash.catch(() => undefined);
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  audit(ctx: AuditContext, entry: AuditEntry): void {
    writeAudit(this.repos(), this.now(), ctx, entry);
  }

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, ...this.params });
  }

  private async verifyHash(hash: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, secret);
    } catch {
      return false;
    }
  }

  // ---- users -------------------------------------------------------------------------------

  userCount(): number {
    return this.repos().users.count();
  }

  getUser(id: number): User | undefined {
    return this.repos().users.get({ id });
  }

  /** First-run setup: creates the single user. The caller checks class and emptiness first. */
  async createUser(username: string, password: string, client: ClientContext): Promise<User> {
    const name = normaliseUsername(username);
    const password_hash = await this.hashPassword(password);
    const repos = this.repos();
    if (repos.users.count() > 0) throw new Error('users already exist');
    const user = repos.users.insert({ username: name, password_hash, created_at: this.iso() });
    this.audit(
      { actor: userActor(name), ...client },
      { action: 'setup', entity: 'user', entityId: String(user.id) },
    );
    return user;
  }

  // ---- lockout -----------------------------------------------------------------------------

  private lockouts(entity: 'ip' | 'username', key: string): { detail: LockoutDetail; at: string }[] {
    return this.repos()
      .auditLog.listFor('lockout', entity, key, this.iso(-LOCKOUT_REPEAT_WINDOW_MS - LOCKOUT_MAX_MS))
      .map((row) => ({ at: row.at, detail: JSON.parse(row.detail ?? '{}') as LockoutDetail }));
  }

  /** Remaining lockout in ms for the client IP or the username (0 when not locked). */
  lockedFor(ip: string, username: string): number {
    const now = this.now();
    let remaining = 0;
    for (const [entity, key] of [
      ['ip', ip],
      ['username', username],
    ] as const) {
      const latest = this.lockouts(entity, key)[0];
      if (latest) remaining = Math.max(remaining, Date.parse(latest.detail.until) - now);
    }
    return remaining;
  }

  /** After a failed attempt: starts a lockout for every key that reached the threshold. */
  private evaluateLockout(client: ClientContext, username: string): void {
    const repos = this.repos();
    const now = this.now();
    for (const [entity, key] of [
      ['ip', client.ip],
      ['username', username],
    ] as const) {
      const history = this.lockouts(entity, key);
      const lastUntil = history[0] ? Date.parse(history[0].detail.until) : 0;
      if (lastUntil > now) continue;
      const since = new Date(Math.max(now - LOCKOUT_WINDOW_MS, lastUntil)).toISOString();
      const by = entity === 'ip' ? { ip: key } : { username: key };
      const failures = repos.loginAttempts.countFailures(by, LOCKABLE, since);
      if (failures < LOCKOUT_THRESHOLD) continue;
      const recent = history.filter((h) => Date.parse(h.at) >= now - LOCKOUT_REPEAT_WINDOW_MS).length;
      const ms = Math.min(LOCKOUT_BASE_MS * 2 ** recent, LOCKOUT_MAX_MS);
      const detail: LockoutDetail = {
        until: new Date(now + ms).toISOString(),
        minutes: ms / MINUTE,
        level: recent + 1,
      };
      this.audit(
        { actor: 'system', ...client },
        { action: 'lockout', entity, entityId: key, detail: { ...detail, failures } },
      );
    }
  }

  private recordAttempt(client: ClientContext, username: string, ok: boolean): void {
    this.repos().loginAttempts.insert({
      at: this.iso(),
      ip: client.ip,
      username,
      channel: client.channel,
      ok: ok ? 1 : 0,
    });
  }

  // ---- login -------------------------------------------------------------------------------

  private async verifySecondFactor(
    user: User,
    totp: string | undefined,
    recovery: string | undefined,
    client: ClientContext,
  ): Promise<boolean> {
    if (totp !== undefined) return this.verifyTotp(user, totp);
    if (recovery !== undefined) return this.consumeRecoveryCode(user, recovery, client);
    return false;
  }

  /**
   * Username + password (+ TOTP or recovery code when enabled). Unknown username and wrong password
   * take the same path: one argon2 verify, one attempt row, the same response.
   */
  async login(
    input: {
      username: string;
      password: string;
      totp?: string | undefined;
      recoveryCode?: string | undefined;
    },
    client: ClientContext,
  ): Promise<LoginResult> {
    const username = normaliseUsername(input.username);
    const lockable = LOCKABLE.includes(client.channel);
    const actor = { actor: userActor(username), ...client };

    if (lockable) {
      const locked = this.lockedFor(client.ip, username);
      if (locked > 0) {
        this.recordAttempt(client, username, false);
        this.audit(actor, { action: 'login_blocked', entity: 'user', entityId: username });
        return { ok: false, error: 'locked_out', retryAfterSeconds: Math.ceil(locked / 1000) };
      }
    }

    const user = this.repos().users.findByUsername(username);
    const passwordOk = await this.verifyHash(user?.password_hash ?? (await this.dummyHash), input.password);
    let error: 'invalid_credentials' | 'totp_required' | undefined;
    if (!user || !passwordOk) {
      error = 'invalid_credentials';
    } else if (user.totp_secret_enc !== null) {
      if (input.totp === undefined && input.recoveryCode === undefined) error = 'totp_required';
      else if (!(await this.verifySecondFactor(user, input.totp, input.recoveryCode, client)))
        error = 'invalid_credentials';
    }

    if (error !== undefined || !user) {
      this.recordAttempt(client, username, false);
      this.audit(actor, {
        action: 'login_failed',
        entity: 'user',
        entityId: username,
        detail: { reason: error === 'totp_required' ? 'totp_required' : 'invalid_credentials' },
      });
      if (lockable) this.evaluateLockout(client, username);
      return { ok: false, error: error ?? 'invalid_credentials' };
    }

    this.recordAttempt(client, username, true);
    this.repos().users.update({ id: user.id }, { last_login_at: this.iso() });
    this.audit(actor, { action: 'login', entity: 'user', entityId: String(user.id) });
    return { ok: true, user };
  }

  /** Step-up: re-enter the password; counts towards lockout like a login attempt. */
  async reauth(session: Session, user: User, password: string, client: ClientContext): Promise<LoginResult> {
    const lockable = LOCKABLE.includes(client.channel);
    const actor = { actor: userActor(user.username), ...client };
    if (lockable) {
      const locked = this.lockedFor(client.ip, user.username);
      if (locked > 0) {
        this.recordAttempt(client, user.username, false);
        this.audit(actor, { action: 'reauth_blocked', entity: 'user', entityId: String(user.id) });
        return { ok: false, error: 'locked_out', retryAfterSeconds: Math.ceil(locked / 1000) };
      }
    }
    const ok = await this.verifyHash(user.password_hash, password);
    this.recordAttempt(client, user.username, ok);
    if (!ok) {
      this.audit(actor, { action: 'reauth_failed', entity: 'user', entityId: String(user.id) });
      if (lockable) this.evaluateLockout(client, user.username);
      return { ok: false, error: 'invalid_credentials' };
    }
    this.repos().sessions.update({ id_hash: session.id_hash }, { last_auth_at: this.iso() });
    this.audit(actor, { action: 'reauth', entity: 'user', entityId: String(user.id) });
    return { ok: true, user };
  }

  async changePassword(user: User, newPassword: string, keepSession: Session, client: ClientContext) {
    const password_hash = await this.hashPassword(newPassword);
    const repos = this.repos();
    repos.users.update({ id: user.id }, { password_hash });
    const revoked = repos.sessions.deleteForUser(user.id, keepSession.id_hash);
    this.audit(
      { actor: userActor(user.username), ...client },
      {
        action: 'password_change',
        entity: 'user',
        entityId: String(user.id),
        detail: { revokedSessions: revoked },
      },
    );
  }

  // ---- sessions ----------------------------------------------------------------------------

  /** Creates a session and returns the opaque id (only its SHA-256 is stored). */
  createSession(user: User, client: ClientContext, ua: string | undefined): { id: string; session: Session } {
    const id = randomBytes(32).toString('base64url');
    const now = this.iso();
    const session = this.repos().sessions.insert({
      id_hash: hashSessionId(id),
      user_id: user.id,
      channel: client.channel,
      created_at: now,
      last_seen_at: now,
      last_auth_at: now,
      expires_at: this.iso(ABSOLUTE_LIFETIME_MS),
      ip: client.ip,
      ua: ua?.slice(0, 512) ?? null,
    });
    return { id, session };
  }

  /**
   * Resolves an opaque session id for a request of class `channel`: checks the channel family
   * (ingress sessions only via ingress, the others only outside it), the 7-day absolute lifetime
   * and the 12-hour idle timeout, then records the activity.
   */
  resolveSession(id: string, channel: RequestClass): { session: Session; user: User } | undefined {
    const repos = this.repos();
    const idHash = hashSessionId(id);
    const session = repos.sessions.get({ id_hash: idHash });
    if (!session) return undefined;
    if ((session.channel === 'ingress') !== (channel === 'ingress')) return undefined;
    const now = this.now();
    if (Date.parse(session.expires_at) <= now || Date.parse(session.last_seen_at) + IDLE_TIMEOUT_MS <= now) {
      repos.sessions.delete({ id_hash: idHash });
      return undefined;
    }
    const user = repos.users.get({ id: session.user_id });
    if (!user) {
      repos.sessions.delete({ id_hash: idHash });
      return undefined;
    }
    const touched = repos.sessions.update({ id_hash: idHash }, { last_seen_at: this.iso() }) ?? session;
    return { session: touched, user };
  }

  deleteSession(idHash: string): boolean {
    return this.repos().sessions.delete({ id_hash: idHash });
  }

  listSessions(userId: number): Session[] {
    return this.repos().sessions.listForUser(userId);
  }

  /** Whether the session authenticated (login or step-up) within the last `maxAgeMs`. */
  isRecentAuth(session: Session, maxAgeMs = STEP_UP_MS): boolean {
    return this.now() - Date.parse(session.last_auth_at) <= maxAgeMs;
  }

  // ---- TOTP --------------------------------------------------------------------------------

  /** Starts enrolment: a new secret, kept in memory until confirmed with a valid code. */
  startTotpEnrolment(user: User): { secret: string; uri: string } {
    const secret = generateSecret();
    this.pendingTotp.set(user.id, { secret, expires: this.now() + TOTP_ENROL_TTL_MS });
    return { secret, uri: generateURI({ issuer: TOTP_ISSUER, label: user.username, secret }) };
  }

  private checkCode(userId: number, secret: string, code: string): boolean {
    if (!/^\d{6}$/.test(code.trim())) return false;
    const last = this.lastTotpStep.get(userId);
    const result = verifySync({
      secret,
      token: code.trim(),
      epoch: Math.floor(this.now() / 1000),
      epochTolerance: 30,
      ...(last !== undefined ? { afterTimeStep: last } : {}),
    });
    if (!result.valid) return false;
    this.lastTotpStep.set(userId, 'timeStep' in result ? result.timeStep : Math.floor(this.now() / 30_000));
    return true;
  }

  /** Confirms enrolment and returns the 10 recovery codes (shown once, stored hashed). */
  async confirmTotpEnrolment(user: User, code: string, client: ClientContext): Promise<string[] | undefined> {
    const pending = this.pendingTotp.get(user.id);
    if (!pending || pending.expires < this.now()) return undefined;
    if (!this.checkCode(user.id, pending.secret, code)) return undefined;
    this.pendingTotp.delete(user.id);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    const hashes = await Promise.all(codes.map((c) => this.hashPassword(normaliseRecoveryCode(c))));
    this.repos().users.update(
      { id: user.id },
      {
        totp_secret_enc: encryptSetting(pending.secret, this.secretKey),
        recovery_codes_hash: JSON.stringify(hashes),
      },
    );
    this.audit(
      { actor: userActor(user.username), ...client },
      { action: 'totp_enable', entity: 'user', entityId: String(user.id) },
    );
    return codes;
  }

  disableTotp(user: User, client: ClientContext): void {
    this.pendingTotp.delete(user.id);
    this.lastTotpStep.delete(user.id);
    this.repos().users.update({ id: user.id }, { totp_secret_enc: null, recovery_codes_hash: null });
    this.audit(
      { actor: userActor(user.username), ...client },
      { action: 'totp_disable', entity: 'user', entityId: String(user.id) },
    );
  }

  private verifyTotp(user: User, code: string): boolean {
    if (user.totp_secret_enc === null) return false;
    return this.checkCode(user.id, decryptSetting(user.totp_secret_enc, this.secretKey), code);
  }

  /** Checks a recovery code against every stored hash; a matching code is removed (single use). */
  private async consumeRecoveryCode(user: User, code: string, client: ClientContext): Promise<boolean> {
    const hashes = JSON.parse(user.recovery_codes_hash ?? '[]') as string[];
    const normalised = normaliseRecoveryCode(code);
    if (normalised.length === 0) return false;
    for (const [i, hash] of hashes.entries()) {
      if (await this.verifyHash(hash, normalised)) {
        // Re-read so two concurrent logins cannot both consume the same code.
        const fresh = this.repos().users.get({ id: user.id });
        const current = JSON.parse(fresh?.recovery_codes_hash ?? '[]') as string[];
        if (!current.includes(hash)) return false;
        const remaining = current.filter((h) => h !== hash);
        this.repos().users.update({ id: user.id }, { recovery_codes_hash: JSON.stringify(remaining) });
        this.audit(
          { actor: userActor(user.username), ...client },
          {
            action: 'recovery_code_used',
            entity: 'user',
            entityId: String(user.id),
            detail: { index: i, remaining: remaining.length },
          },
        );
        return true;
      }
    }
    return false;
  }
}
