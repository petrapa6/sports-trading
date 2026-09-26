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

export { formatUsd } from './format';

/** A readable message for a failed Kalshi action (`{error, message}` from the server). */
export function kalshiErrorMessage(err: unknown): string {
  if (err instanceof ApiError && typeof err.body['message'] === 'string') return err.body['message'];
  if (err instanceof ApiError) return `The request failed (${err.code}).`;
  return 'The request failed.';
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
  kalshiSeries: string;
  includePreseason: boolean;
  enabled: boolean;
}

export interface KalshiSeries {
  ticker: string;
  title: string | null;
}

export interface LeagueDiscovery {
  leagueId: string;
  series: string;
  events: number;
  skippedPreseason: number;
  skippedNoMilestone: number;
  games: number;
  markets: number;
  unknownMarkets: number;
  error?: string;
}

export interface DiscoveryResult {
  startedAt: string;
  finishedAt: string;
  leagues: LeagueDiscovery[];
}

export interface KalshiConnectionTest {
  env: KalshiEnv;
  subaccount: number;
  ok: boolean;
  balance?: { cashMicros: number; portfolioValueMicros: number | null };
  exchange?: { exchangeActive: boolean; tradingActive: boolean };
  error?: string;
  code?: string;
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

// ---- Live games and the trading loop (T07) ----------------------------------------------------

export type Phase = 'scheduled' | 'live' | 'halftime' | 'intermission' | 'finished' | 'postponed';

export interface GameClock {
  minute?: number;
  minuteSource?: 'feed' | 'derived';
  period?: number;
  secondsLeftInPeriod?: number;
  regulationOver: boolean;
}

export interface GameView {
  id: string;
  leagueId: string;
  sport: 'soccer' | 'hockey';
  competition: string | null;
  homeTeam: string;
  awayTeam: string;
  homeAbbr: string | null;
  awayAbbr: string | null;
  homeScore: number | null;
  awayScore: number | null;
  phase: Phase;
  clock: GameClock;
  blocked: boolean;
  scheduledAt: string;
  observedAt: string | null;
  source: string | null;
  strategies: ArmedStrategy[];
}

// ---- Strategies and signals (T08) -----------------------------------------------------------------

export type ConfiguredMode = 'live' | 'dry_run';
export type DryRunReason = 'addon_lock' | 'global_dry_run' | 'strategy';
export type PauseReason = 'global_kill_switch' | 'strategy_kill_switch';

/** A strategy armed on a game card (running, league and sport match). */
export interface ArmedStrategy {
  id: string;
  name: string;
  configuredMode: ConfiguredMode;
  effectiveMode: ConfiguredMode;
  modeReason: DryRunReason | null;
}

export interface ModeStats {
  trades: number;
  pnlMicros: number;
}

export interface StrategyView {
  id: string;
  name: string;
  sport: 'soccer' | 'hockey';
  leagueIds: string[];
  mode: ConfiguredMode;
  killSwitch: boolean;
  effectiveMode: 'paused' | ConfiguredMode;
  modeReason: DryRunReason | PauseReason | null;
  runningMode: ConfiguredMode;
  currentVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  rule: StrategyRule | null;
  sizing: StrategySizing | null;
  execution: StrategyExecution | null;
  last30d: { live: ModeStats; dry_run: ModeStats };
}

export interface StrategyRule {
  type: 'lead_at_time';
  version: number;
  minLead: number;
  atMinute: number;
  windowMinutes: number;
  leaderSide: 'any' | 'home' | 'away';
}

export interface StrategySizing {
  type: 'percent_of_balance';
  percent: number;
  minStakeUsd: number;
  maxStakeUsd: number;
}

export interface StrategyExecution {
  orderType: 'ioc_limit';
  maxPrice: number;
  minPrice: number | null;
  maxSlippage: number;
  minDepthContracts: number;
  maxFeedAgeSec: number;
}

export interface StrategyVersionView {
  version: number;
  createdAt: string | null;
  leagueIds: string[];
  rule: StrategyRule;
  sizing: StrategySizing;
  execution: StrategyExecution;
}

export interface StrategyDetail extends StrategyView {
  versions: StrategyVersionView[];
}

export interface Signal {
  strategyId: string;
  strategyName: string;
  version: number;
  gameId: string;
  leagueId: string;
  sport: 'soccer' | 'hockey';
  side: 'home' | 'away';
  marketTicker: string | null;
  minute: number;
  snapshot: {
    gameId: string;
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
    phase: Phase;
    clock: GameClock;
    observedAt: string;
  };
  configuredMode: ConfiguredMode;
  effectiveMode: ConfiguredMode;
  modeReason: DryRunReason | null;
  at: string;
}

export type FeedHealth = 'ok' | 'error' | 'idle' | 'disabled' | 'paused' | 'unavailable';

export interface FeedStatus {
  id: string;
  name: string;
  enabled: boolean;
  available: boolean;
  status: FeedHealth;
  lastPollAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface LoopStatus {
  state: 'starting' | 'running' | 'idle' | 'paused' | 'stopped' | 'stale';
  lastTickAt: string | null;
  lastPollAt: string | null;
  cadenceMs: number | null;
  trackedGames: number;
  feeds: FeedStatus[];
  balance: { cashMicros: number | null; at: string | null; error: string | null };
}

export interface FeedInfo {
  id: string;
  name: string;
  sports: string[];
  enabled: boolean;
  available: boolean;
  status: FeedHealth;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface FeedTestResult {
  id: string;
  name: string;
  enabled: boolean;
  ok: boolean;
  message: string;
}
