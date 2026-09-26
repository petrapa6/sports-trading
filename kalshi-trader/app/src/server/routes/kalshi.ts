import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type { KalshiEnv } from '../../config.js';
import type { DatabaseManager } from '../../db/database.js';
import {
  KalshiApiError,
  KalshiNetworkError,
  KalshiUnavailable,
  type KalshiClient,
} from '../../feeds/kalshi/client.js';
import { DiscoveryRunning, type DiscoveryService } from '../../feeds/kalshi/discovery.js';
import { NetworkPaused } from '../../feeds/network.js';
import { userActor } from '../audit.js';
import { HttpError, parseBody } from '../http.js';
import { authOf, clientContext } from '../security.js';

/**
 * Kalshi access for the app and the UI (T06). `client` and `discovery` are absent while the Kalshi
 * credentials are not configured; every Kalshi action then answers a readable error.
 */
export interface KalshiServices {
  env: KalshiEnv;
  subaccount: number;
  client?: KalshiClient | undefined;
  discovery?: DiscoveryService | undefined;
}

/** A stable code and a sentence a person can act on, for any error from a Kalshi call. */
export function describeKalshiError(err: unknown): { code: string; status: number; message: string } {
  if (err instanceof NetworkPaused)
    return {
      code: 'network_paused',
      status: 409,
      message: 'The global kill switch is on, so the app makes no outgoing requests.',
    };
  if (err instanceof KalshiApiError) {
    const hint =
      err.status === 401 || err.status === 403
        ? ' Check the key id, the private key and the Kalshi environment.'
        : '';
    return {
      code: 'kalshi_rejected',
      status: 502,
      message: `Kalshi rejected the request (${err.status}${err.code ? ` ${err.code}` : ''}).${hint}`,
    };
  }
  if (err instanceof KalshiUnavailable)
    return {
      code: 'kalshi_unavailable',
      status: 502,
      message: `Kalshi is unavailable (${err.status} after ${err.attempts} attempts). Try again later.`,
    };
  if (err instanceof KalshiNetworkError)
    return { code: 'kalshi_unreachable', status: 502, message: `${err.message}.` };
  if (err instanceof ZodError)
    return {
      code: 'kalshi_bad_response',
      status: 502,
      message: `Kalshi answered with an unexpected payload (${err.issues[0]?.path.join('.') || 'body'}).`,
    };
  return { code: 'kalshi_error', status: 502, message: 'The Kalshi request failed.' };
}

const NOT_CONFIGURED = {
  code: 'kalshi_not_configured',
  status: 503,
  message:
    'Kalshi credentials are not configured: set the key id and the private key in the app configuration.',
};

const LeaguePatch = z
  .object({
    enabled: z.boolean().optional(),
    include_preseason: z.boolean().optional(),
    kalshi_series: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/, 'must be an upper-case Kalshi series ticker')
      .optional(),
  })
  .strict();

const toApiLeague = (l: {
  id: string;
  sport: string;
  name: string;
  kalshi_series: string;
  include_preseason: number;
  enabled: number;
}) => ({
  id: l.id,
  sport: l.sport,
  name: l.name,
  kalshiSeries: l.kalshi_series,
  includePreseason: l.include_preseason === 1,
  enabled: l.enabled === 1,
});

export function registerKalshiRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  kalshi: KalshiServices,
): void {
  const auth = app.authService;

  const fail = (err: unknown): never => {
    const d = describeKalshiError(err);
    throw new HttpError(d.status, d.code, { message: d.message });
  };
  const client = (): KalshiClient => {
    if (!kalshi.client)
      throw new HttpError(NOT_CONFIGURED.status, NOT_CONFIGURED.code, { message: NOT_CONFIGURED.message });
    return kalshi.client;
  };

  /** Leagues for the filter bar and Settings → Leagues. */
  app.get('/api/leagues', async () => database.repositories.leagues.list().map(toApiLeague));

  /** Settings → Leagues: enable, series ticker, include preseason. Audited. */
  app.post<{ Params: { id: string } }>('/api/leagues/:id', async (req) => {
    const patch = parseBody(LeaguePatch, req.body);
    const leagues = database.repositories.leagues;
    const league = leagues.get({ id: req.params.id });
    if (!league) throw new HttpError(404, 'not_found');
    const row: { enabled?: number; include_preseason?: number; kalshi_series?: string } = {};
    if (patch.enabled !== undefined) row.enabled = patch.enabled ? 1 : 0;
    if (patch.include_preseason !== undefined) row.include_preseason = patch.include_preseason ? 1 : 0;
    if (patch.kalshi_series !== undefined) row.kalshi_series = patch.kalshi_series;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(row)) {
      const from = league[k as keyof typeof row];
      if (from !== v) changes[k] = { from, to: v };
    }
    if (Object.keys(changes).length === 0) return toApiLeague(league);
    const updated = leagues.update({ id: league.id }, row);
    const { user } = authOf(req);
    auth.audit(
      { actor: userActor(user.username), ...clientContext(req) },
      { action: 'league_change', entity: 'league', entityId: league.id, detail: changes },
    );
    req.log.info({ leagueId: league.id, changes }, 'League settings changed');
    return toApiLeague(updated ?? league);
  });

  /** "Discover series": Sports series whose ticker ends in `GAME`. */
  app.get('/api/kalshi/series', async () => {
    const c = client();
    try {
      const series = await c.listSeries({ category: 'Sports' });
      return series
        .filter((s) => s.ticker.endsWith('GAME'))
        .map((s) => ({ ticker: s.ticker, title: s.title ?? null }))
        .sort((a, b) => a.ticker.localeCompare(b.ticker));
    } catch (err) {
      return fail(err);
    }
  });

  /** "Run discovery now". */
  app.post('/api/kalshi/discovery', async (req) => {
    client();
    const discovery = kalshi.discovery;
    if (!discovery)
      throw new HttpError(NOT_CONFIGURED.status, NOT_CONFIGURED.code, { message: NOT_CONFIGURED.message });
    const { user } = authOf(req);
    auth.audit(
      { actor: userActor(user.username), ...clientContext(req) },
      { action: 'discovery_run', entity: 'discovery' },
    );
    try {
      return await discovery.run('manual');
    } catch (err) {
      if (err instanceof DiscoveryRunning)
        throw new HttpError(409, 'discovery_running', { message: 'A discovery run is already in progress.' });
      return fail(err);
    }
  });

  /**
   * Settings → Diagnostics → "Test Kalshi connection": environment, subaccount, balance and exchange
   * status. Always `200`; a failure is reported as `ok: false` with a readable `error`.
   */
  app.post('/api/diagnostics/kalshi', async () => {
    const base = { env: kalshi.env, subaccount: kalshi.subaccount };
    if (!kalshi.client)
      return { ...base, ok: false, error: NOT_CONFIGURED.message, code: NOT_CONFIGURED.code };
    try {
      const [balance, exchange] = await Promise.all([
        kalshi.client.getBalance(),
        kalshi.client.getExchangeStatus(),
      ]);
      return {
        ...base,
        ok: true,
        balance: { cashMicros: balance.cash_micros, portfolioValueMicros: balance.portfolio_value_micros },
        exchange: { exchangeActive: exchange.exchange_active, tradingActive: exchange.trading_active },
      };
    } catch (err) {
      const d = describeKalshiError(err);
      return { ...base, ok: false, error: d.message, code: d.code };
    }
  });
}
