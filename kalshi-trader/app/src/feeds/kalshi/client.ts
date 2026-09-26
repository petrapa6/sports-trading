import type { KeyObject } from 'node:crypto';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { KalshiEnv } from '../../config.js';
import { bpToDollars } from '../../core/decimal.js';
import type { NetworkGate } from '../network.js';
import { BASIC_TIER, TokenBucket, type RateLimitOptions } from './rateLimiter.js';
import * as S from './schemas.js';
import { authHeaders, loadSigningKey } from './signing.js';

/**
 * Thin hand-written Kalshi Trade API v2 client (SPEC.md §2 API essentials, T06).
 *
 * - Every request passes the network gate first (`NetworkPaused` while the global kill switch is on),
 *   then a token bucket (reads / writes), then is signed with RSA-PSS and sent.
 * - `429` and `5xx` are retried with exponential backoff (0.5, 1, 2, 4, 8 s; at most 5 attempts), then
 *   `KalshiUnavailable` is thrown. Other `4xx` throw `KalshiApiError` at once.
 * - Every response is Zod-validated (unknown fields pass, a missing required field throws the `ZodError`)
 *   and converted to integer units (`_bp`, `_micros`, `_cc`).
 * - Only method + path (no query, no body, no headers) are ever logged.
 * - `subaccount` is sent on portfolio requests when `KALSHI_SUBACCOUNT > 0`.
 */

export const BASE_URLS: Record<KalshiEnv, string> = {
  prod: 'https://external-api.kalshi.com/trade-api/v2',
  demo: 'https://external-api.demo.kalshi.co/trade-api/v2',
};

export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
export const MAX_ATTEMPTS = 5;

export class KalshiError extends Error {
  override name = 'KalshiError';
}

/** `429` / `5xx` still failing after `MAX_ATTEMPTS` attempts. */
export class KalshiUnavailable extends KalshiError {
  override name = 'KalshiUnavailable';
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly attempts: number,
  ) {
    super(`Kalshi unavailable: ${method} ${path} answered ${status} after ${attempts} attempts`);
  }
}

/** A `4xx` other than `429` (the request itself was rejected). */
export class KalshiApiError extends KalshiError {
  override name = 'KalshiApiError';
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: string | null,
    detail: string | null,
  ) {
    super(
      `Kalshi rejected ${method} ${path}: ${status}${code ? ` ${code}` : ''}${detail ? ` (${detail})` : ''}`,
    );
  }
}

/** The request never got an HTTP answer (DNS, connection refused, TLS, …). */
export class KalshiNetworkError extends KalshiError {
  override name = 'KalshiNetworkError';
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown,
  ) {
    const code = (cause as { cause?: { code?: unknown } } | null)?.cause?.code;
    super(`Kalshi could not be reached: ${method} ${path}${typeof code === 'string' ? ` (${code})` : ''}`, {
      cause,
    });
  }
}

export interface KalshiClientOptions {
  env: KalshiEnv;
  keyId: string;
  /** PEM private key (RSA) or an already parsed key. */
  privateKey: string | KeyObject;
  subaccount: number;
  gate: NetworkGate;
  log: Logger;
  /** Overrides the environment's base URL (tests and the e2e stand-in only). */
  baseUrl?: string;
  rateLimits?: RateLimitOptions;
  fetch?: typeof fetch;
  now?: () => number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions<T extends z.ZodType> {
  query?: Query;
  body?: unknown;
  schema: T;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}

export interface CandleRange {
  /** Epoch ms (sent as unix seconds). */
  startMs: number;
  endMs: number;
  /** Minutes per candle; the app uses 1. */
  periodInterval?: number;
}

export interface CreateOrderInput {
  ticker: string;
  /** Whole contracts. */
  contracts: number;
  /** Limit price. */
  priceBp: number;
  clientOrderId: string;
  orderGroupId: string;
}

const MAX_PAGES = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KalshiClient {
  readonly env: KalshiEnv;
  readonly subaccount: number;
  readonly baseUrl: string;
  private readonly keyId: string;
  private readonly key: KeyObject;
  private readonly gate: NetworkGate;
  private readonly log: Logger;
  private readonly read: TokenBucket;
  private readonly write: TokenBucket;
  private readonly limits: RateLimitOptions;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(options: KalshiClientOptions) {
    this.env = options.env;
    this.subaccount = options.subaccount;
    this.baseUrl = (options.baseUrl ?? BASE_URLS[options.env]).replace(/\/+$/, '');
    this.keyId = options.keyId;
    this.key =
      typeof options.privateKey === 'string' ? loadSigningKey(options.privateKey) : options.privateKey;
    this.gate = options.gate;
    this.log = options.log.child({ component: 'kalshi' });
    this.limits = options.rateLimits ?? BASIC_TIER;
    this.now = options.now ?? (() => Date.now());
    this.read = new TokenBucket({
      ratePerSec: this.limits.readPerSec,
      capacitySec: this.limits.readCapacitySec,
      now: this.now,
    });
    this.write = new TokenBucket({
      ratePerSec: this.limits.writePerSec,
      capacitySec: this.limits.writeCapacitySec,
      now: this.now,
    });
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Tokens left in the read and write buckets (diagnostics, tests). */
  tokens(): { read: number; write: number } {
    return { read: this.read.available(), write: this.write.available() };
  }

  private cost(method: string, template: string): number {
    return this.limits.costs?.[`${method} ${template}`] ?? this.limits.defaultCost;
  }

  private subaccountQuery(): Query {
    return this.subaccount > 0 ? { subaccount: this.subaccount } : {};
  }

  /**
   * One API call: gate → bucket → sign → fetch, with backoff on 429/5xx. `template` names the
   * endpoint for per-endpoint costs and is what gets logged (never the query or the body).
   */
  private async request<T extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: RequestOptions<T>,
  ): Promise<z.output<T>> {
    this.gate.assertNetworkAllowed();
    const bucket = method === 'GET' ? this.read : this.write;
    const cost = this.cost(method, path);
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const logPath = url.pathname;

    for (let attempt = 1; ; attempt++) {
      await bucket.take(cost);
      // The switch may have been turned on while this request waited for tokens or a backoff.
      this.gate.assertNetworkAllowed();
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...authHeaders(this.keyId, this.key, this.now(), method, url.pathname),
      };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (err) {
        this.log.warn({ method, path: logPath }, 'Kalshi request failed (network)');
        throw new KalshiNetworkError(method, logPath, err);
      }
      this.log.debug(
        { method, path: logPath, status: res.status, ms: Date.now() - started },
        'Kalshi request',
      );

      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        if (attempt >= MAX_ATTEMPTS) {
          this.log.warn(
            { method, path: logPath, status: res.status, attempts: attempt },
            'Kalshi unavailable',
          );
          throw new KalshiUnavailable(method, logPath, res.status, attempt);
        }
        const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        this.log.info(
          { method, path: logPath, status: res.status, attempt, delayMs: delay },
          'Kalshi backoff',
        );
        await sleep(delay as number);
        continue;
      }
      if (!res.ok) {
        const { code, detail } = await errorInfo(res);
        this.log.warn({ method, path: logPath, status: res.status, code }, 'Kalshi request rejected');
        throw new KalshiApiError(method, logPath, res.status, code, detail);
      }
      const json: unknown = res.status === 204 ? {} : await res.json();
      return options.schema.parse(json) as z.output<T>;
    }
  }

  private async paginate<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await fetchPage(cursor);
      out.push(...page.items);
      if (!page.cursor) return out;
      cursor = page.cursor;
    }
    throw new KalshiError(`pagination did not finish within ${MAX_PAGES} pages`);
  }

  /** A raw GET (validated only as an object); used by `npm run fixtures:record:kalshi`. */
  async getRaw(path: string, query: Query = {}): Promise<unknown> {
    return this.request('GET', path, { query, schema: S.EmptyResponseSchema });
  }

  // ---- account and exchange ---------------------------------------------------------------

  async getBalance(): Promise<S.Balance> {
    const raw = await this.request('GET', '/portfolio/balance', {
      query: this.subaccountQuery(),
      schema: S.BalanceSchema,
    });
    return S.toBalance(raw);
  }

  getExchangeStatus(): Promise<S.ExchangeStatus> {
    return this.request('GET', '/exchange/status', { schema: S.ExchangeStatusSchema });
  }

  getExchangeSchedule(): Promise<S.ExchangeSchedule> {
    return this.request('GET', '/exchange/schedule', { schema: S.ExchangeScheduleSchema });
  }

  /** Manual use only (Settings never calls it): upgrades the account to the Advanced API tier (SPEC.md §10). */
  upgradeApiUsageLevel(): Promise<unknown> {
    return this.request('POST', '/account/api_usage_level/upgrade', {
      body: {},
      schema: S.EmptyResponseSchema,
    });
  }

  // ---- series, events, milestones, markets ------------------------------------------------

  /** Every series of a category (all pages). */
  listSeries(filter: { category?: string } = {}): Promise<S.Series[]> {
    return this.paginate(async (cursor) => {
      const r = await this.request('GET', '/series', {
        query: { category: filter.category, cursor },
        schema: S.SeriesListSchema,
      });
      return { items: r.series ?? [], cursor: r.cursor ?? null };
    });
  }

  async getSeries(ticker: string): Promise<S.Series> {
    return (await this.request('GET', `/series/${enc(ticker)}`, { schema: S.SeriesResponseSchema })).series;
  }

  /** One page of events. */
  async listEvents(
    seriesTicker: string,
    status?: string,
    withNestedMarkets = false,
    cursor?: string,
    limit = 200,
  ): Promise<Page<S.KalshiEvent>> {
    const r = await this.request('GET', '/events', {
      query: {
        series_ticker: seriesTicker,
        status,
        with_nested_markets: withNestedMarkets ? 'true' : undefined,
        limit,
        cursor,
      },
      schema: S.EventsListSchema,
    });
    return { items: (r.events ?? []).map((e) => S.toEvent(e)), cursor: r.cursor ?? null };
  }

  /** Every event of a series (all pages). */
  listAllEvents(seriesTicker: string, status?: string, withNestedMarkets = false): Promise<S.KalshiEvent[]> {
    return this.paginate((cursor) => this.listEvents(seriesTicker, status, withNestedMarkets, cursor));
  }

  async getEvent(eventTicker: string): Promise<S.KalshiEvent> {
    const r = await this.request('GET', `/events/${enc(eventTicker)}`, { schema: S.EventResponseSchema });
    return S.toEvent(r.event, r.markets);
  }

  listMilestones(filter: { relatedEventTicker: string }): Promise<S.Milestone[]> {
    return this.paginate(async (cursor) => {
      const r = await this.request('GET', '/milestones', {
        query: { related_event_ticker: filter.relatedEventTicker, limit: 100, cursor },
        schema: S.MilestonesListSchema,
      });
      return { items: r.milestones ?? [], cursor: r.cursor ?? null };
    });
  }

  async getMarket(ticker: string): Promise<S.Market> {
    return S.toMarket(
      (await this.request('GET', `/markets/${enc(ticker)}`, { schema: S.MarketResponseSchema })).market,
    );
  }

  async getHistoricalMarket(ticker: string): Promise<S.Market> {
    return S.toMarket(
      (await this.request('GET', `/historical/markets/${enc(ticker)}`, { schema: S.MarketResponseSchema }))
        .market,
    );
  }

  async getOrderbook(ticker: string): Promise<S.Orderbook> {
    return S.toOrderbook(
      await this.request('GET', `/markets/${enc(ticker)}/orderbook`, { schema: S.OrderbookResponseSchema }),
    );
  }

  private candleQuery(range: CandleRange): Query {
    return {
      start_ts: Math.floor(range.startMs / 1000),
      end_ts: Math.floor(range.endMs / 1000),
      period_interval: range.periodInterval ?? 1,
    };
  }

  async getCandlesticks(seriesTicker: string, ticker: string, range: CandleRange): Promise<S.Candle[]> {
    const r = await this.request('GET', `/series/${enc(seriesTicker)}/markets/${enc(ticker)}/candlesticks`, {
      query: this.candleQuery(range),
      schema: S.CandlesticksResponseSchema,
    });
    return r.candlesticks.map(S.toCandle);
  }

  async getHistoricalCandlesticks(ticker: string, range: CandleRange): Promise<S.Candle[]> {
    const r = await this.request('GET', `/historical/markets/${enc(ticker)}/candlesticks`, {
      query: this.candleQuery(range),
      schema: S.CandlesticksResponseSchema,
    });
    return r.candlesticks.map(S.toCandle);
  }

  async getHistoricalCutoff(): Promise<S.HistoricalCutoff> {
    return S.toCutoff(await this.request('GET', '/historical/cutoff', { schema: S.HistoricalCutoffSchema }));
  }

  // ---- live data ----------------------------------------------------------------------------

  async getLiveData(milestoneId: string): Promise<S.LiveData> {
    return (
      await this.request('GET', `/live_data/milestone/${enc(milestoneId)}`, {
        schema: S.LiveDataResponseSchema,
      })
    ).live_data;
  }

  /** "Get Multiple Live Data": one call for every tracked milestone. */
  async getLiveDataBatch(milestoneIds: readonly string[]): Promise<S.LiveData[]> {
    if (milestoneIds.length === 0) return [];
    const r = await this.request('GET', '/live_data/batch', {
      query: { milestone_ids: milestoneIds.join(',') },
      schema: S.LiveDataBatchResponseSchema,
    });
    return r.live_datas ?? r.live_data ?? [];
  }

  getGameStats(milestoneId: string): Promise<S.GameStats> {
    return this.request('GET', `/live_data/milestone/${enc(milestoneId)}/game_stats`, {
      schema: S.GameStatsResponseSchema,
    });
  }

  // ---- orders (nothing in the app calls these before T13) ----------------------------------

  /** Create Order V2: an immediate-or-cancel buy of YES (`side: "bid"`) at a limit price. */
  async createOrderV2(input: CreateOrderInput): Promise<S.OrderResult> {
    if (!Number.isSafeInteger(input.contracts) || input.contracts < 1) {
      throw new RangeError('createOrderV2: contracts must be a positive integer');
    }
    const body: Record<string, unknown> = {
      ticker: input.ticker,
      side: 'bid',
      count: String(input.contracts),
      price: bpToDollars(input.priceBp),
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      client_order_id: input.clientOrderId,
      order_group_id: input.orderGroupId,
    };
    if (this.subaccount > 0) body['subaccount'] = this.subaccount;
    const r = await this.request('POST', '/portfolio/events/orders', {
      body,
      schema: S.CreateOrderResponseSchema,
    });
    return S.toOrderResult(r);
  }

  /** Orders filtered by ticker and time (there is no `client_order_id` filter; match it yourself). All pages. */
  getOrders(filter: { ticker?: string; minTs?: number; status?: string } = {}): Promise<S.Order[]> {
    return this.ordersFrom('/portfolio/orders', filter);
  }

  /** Orders older than the historical cutoff. All pages. */
  getHistoricalOrders(filter: { ticker?: string; minTs?: number; status?: string } = {}): Promise<S.Order[]> {
    return this.ordersFrom('/historical/orders', filter);
  }

  private ordersFrom(
    path: string,
    filter: { ticker?: string; minTs?: number; status?: string },
  ): Promise<S.Order[]> {
    return this.paginate(async (cursor) => {
      const r = await this.request('GET', path, {
        query: {
          ticker: filter.ticker,
          min_ts: filter.minTs !== undefined ? Math.floor(filter.minTs / 1000) : undefined,
          status: filter.status,
          limit: 200,
          cursor,
          ...this.subaccountQuery(),
        },
        schema: S.OrdersListSchema,
      });
      return { items: (r.orders ?? []).map(S.toOrder), cursor: r.cursor ?? null };
    });
  }

  getPositions(filter: { ticker?: string } = {}): Promise<S.Position[]> {
    return this.paginate(async (cursor) => {
      const r = await this.request('GET', '/portfolio/positions', {
        query: { ticker: filter.ticker, limit: 200, cursor, ...this.subaccountQuery() },
        schema: S.PositionsListSchema,
      });
      return { items: (r.market_positions ?? []).map(S.toPosition), cursor: r.cursor ?? null };
    });
  }

  getSettlements(filter: { ticker?: string } = {}): Promise<S.Settlement[]> {
    return this.paginate(async (cursor) => {
      const r = await this.request('GET', '/portfolio/settlements', {
        query: { ticker: filter.ticker, limit: 200, cursor, ...this.subaccountQuery() },
        schema: S.SettlementsListSchema,
      });
      return { items: (r.settlements ?? []).map(S.toSettlement), cursor: r.cursor ?? null };
    });
  }

  getFills(filter: { ticker?: string; orderId?: string; minTs?: number } = {}): Promise<S.Fill[]> {
    return this.paginate(async (cursor) => {
      const r = await this.request('GET', '/portfolio/fills', {
        query: {
          ticker: filter.ticker,
          order_id: filter.orderId,
          min_ts: filter.minTs !== undefined ? Math.floor(filter.minTs / 1000) : undefined,
          limit: 200,
          cursor,
          ...this.subaccountQuery(),
        },
        schema: S.FillsListSchema,
      });
      return { items: (r.fills ?? []).map(S.toFill), cursor: r.cursor ?? null };
    });
  }

  async createOrderGroup(contractsLimit: number): Promise<string> {
    const body: Record<string, unknown> = { contracts_limit: contractsLimit };
    if (this.subaccount > 0) body['subaccount'] = this.subaccount;
    return (
      await this.request('POST', '/portfolio/order_groups/create', {
        body,
        schema: S.CreateOrderGroupResponseSchema,
      })
    ).order_group_id;
  }

  getOrderGroup(orderGroupId: string): Promise<S.OrderGroup> {
    return this.request('GET', `/portfolio/order_groups/${enc(orderGroupId)}`, {
      query: this.subaccountQuery(),
      schema: S.OrderGroupResponseSchema,
    });
  }

  async resetOrderGroup(orderGroupId: string): Promise<void> {
    await this.request('PUT', `/portfolio/order_groups/${enc(orderGroupId)}/reset`, {
      body: this.subaccount > 0 ? { subaccount: this.subaccount } : {},
      schema: S.EmptyResponseSchema,
    });
  }
}

const enc = encodeURIComponent;

/** `{"error": {"code", "message"}}` (or a flat variant) from an error response; never the whole body. */
async function errorInfo(res: Response): Promise<{ code: string | null; detail: string | null }> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = (
      typeof body['error'] === 'object' && body['error'] !== null ? body['error'] : body
    ) as Record<string, unknown>;
    const code = typeof err['code'] === 'string' ? err['code'].slice(0, 80) : null;
    const message = typeof err['message'] === 'string' ? err['message'].slice(0, 200) : null;
    return { code, detail: message };
  } catch {
    return { code: null, detail: null };
  }
}
