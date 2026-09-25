import { endpoint } from './base';

/** An error response from the server: HTTP status and its stable `error` code. */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(`${status} ${code}`);
  }
}

let csrfToken: string | undefined;
/** Endpoints used before a session exists; they take no CSRF token. */
const NO_SESSION = new Set(['login', 'setup']);
let onUnauthorized: () => void = () => undefined;

/** Forget the CSRF token (it is bound to the session: call after sign-in and sign-out). */
export function resetCsrf(): void {
  csrfToken = undefined;
}

/** Called when a request answers `401 unauthorized` (session expired or revoked). */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function csrf(): Promise<string> {
  csrfToken ??= (await request<{ token: string }>('GET', 'api/csrf')).token;
  return csrfToken;
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && !NO_SESSION.has(path)) headers['x-csrf-token'] = await csrf();
  const res = await fetch(endpoint(path), {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data['error'] === 'string' ? data['error'] : 'error';
    if (res.status === 403 && code === 'csrf' && !retried) {
      resetCsrf();
      return request<T>(method, path, body, true);
    }
    if (res.status === 401 && code === 'unauthorized') onUnauthorized();
    throw new ApiError(res.status, code, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
};

// ---- Response types ------------------------------------------------------------------------

export type KalshiEnv = 'demo' | 'prod';

export interface Me {
  username: string;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  channel: string;
  lastAuthAt: string;
  reauthRequired: boolean;
}

export interface SwitchStates {
  globalKillSwitch: boolean;
  globalDryRun: boolean;
  allowLiveOrders: boolean;
  kalshiEnv: KalshiEnv;
  kalshiSubaccount: number;
}

export interface Status extends SwitchStates {
  version: string;
}

export interface League {
  id: string;
  sport: string;
  name: string;
  enabled: boolean;
}

export interface StrategyRef {
  id: string;
  name: string;
  sport: string;
}

export interface SessionRow {
  id: string;
  channel: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  ua: string | null;
  current: boolean;
}

export interface Diagnostics {
  version: string;
  dbPath: string;
  dbSizeBytes: number;
}

export type LogMode = 'live' | 'dry_run' | null;

export interface LogEntry {
  seq: number;
  time: string;
  level: string;
  msg: string;
  mode: LogMode;
}
