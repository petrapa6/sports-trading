/**
 * Zod schemas for every Kalshi response the client reads, and their conversion into the app's integer
 * units (SPEC.md conventions): prices → `_bp` ($0.0001), money → `_micros`, counts → `_cc`
 * (centi-contracts). Payloads are untrusted input: every object is validated with `.passthrough()` so
 * unknown fields pass, while a missing required field fails with a `ZodError` naming it.
 *
 * `*_dollars` / `*_fp` strings go through `core/decimal.ts` only. Legacy integer fields (cents,
 * whole contracts) are used only when the `*_dollars` / `*_fp` field is absent.
 */
import { z } from 'zod';
import { dollarsToBp, dollarsToMicros, fpToCc } from '../../core/decimal.js';

const str = z.string();
const optStr = z.string().nullish();
/** A decimal string such as `"0.9300"` (validated again, exactly, by `core/decimal.ts`). */
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');
const optDecimal = decimal.nullish();
const int = z.number().int();

// ---- conversions ---------------------------------------------------------------------------

/** `*_dollars` price string, else legacy integer cents, else null. */
export function priceBp(dollars: string | null | undefined, cents?: number | null): number | null {
  if (dollars !== undefined && dollars !== null) return dollarsToBp(dollars);
  if (cents !== undefined && cents !== null) return cents * 100;
  return null;
}

/** `*_dollars` money string, else legacy integer cents, else null. */
export function moneyMicros(dollars: string | null | undefined, cents?: number | null): number | null {
  if (dollars !== undefined && dollars !== null) return dollarsToMicros(dollars);
  if (cents !== undefined && cents !== null) return cents * 10_000;
  return null;
}

/** `*_fp` count string, else legacy whole contracts, else null. */
export function countCc(fp: string | null | undefined, contracts?: number | null): number | null {
  if (fp !== undefined && fp !== null) return fpToCc(fp);
  if (contracts !== undefined && contracts !== null) return contracts * 100;
  return null;
}

/** ISO string or unix seconds → epoch ms (null when absent). */
export function toEpochMs(v: string | number | null | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`not a timestamp: ${v}`);
  return ms;
}

// ---- balance / exchange --------------------------------------------------------------------

export const BalanceSchema = z
  .object({
    balance: int.nullish(),
    balance_dollars: optDecimal,
    portfolio_value: int.nullish(),
    portfolio_value_dollars: optDecimal,
    updated_ts: z.number().nullish(),
  })
  .passthrough()
  .refine((b) => b.balance_dollars != null || b.balance != null, {
    message: 'balance or balance_dollars is required',
    path: ['balance'],
  });

export interface Balance {
  cash_micros: number;
  portfolio_value_micros: number | null;
}

export function toBalance(raw: z.output<typeof BalanceSchema>): Balance {
  return {
    cash_micros: moneyMicros(raw.balance_dollars, raw.balance) as number,
    portfolio_value_micros: moneyMicros(raw.portfolio_value_dollars, raw.portfolio_value),
  };
}

export const ExchangeStatusSchema = z
  .object({
    exchange_active: z.boolean(),
    trading_active: z.boolean(),
    exchange_estimated_resume_time: optStr,
  })
  .passthrough();
export type ExchangeStatus = z.output<typeof ExchangeStatusSchema>;

export const ExchangeScheduleSchema = z
  .object({
    schedule: z
      .object({
        standard_hours: z.array(z.unknown()).nullish(),
        maintenance_windows: z
          .array(z.object({ start_datetime: str, end_datetime: str }).passthrough())
          .nullish(),
      })
      .passthrough(),
  })
  .passthrough();
export type ExchangeSchedule = z.output<typeof ExchangeScheduleSchema>;

// ---- series / events / markets ------------------------------------------------------------

export const SeriesSchema = z
  .object({
    ticker: str,
    title: optStr,
    category: optStr,
    frequency: optStr,
    tags: z.array(str).nullish(),
    fee_type: optStr,
    fee_multiplier: z.number().nullish(),
  })
  .passthrough();
export type Series = z.output<typeof SeriesSchema>;

export const SeriesListSchema = z
  .object({ series: z.array(SeriesSchema).nullish(), cursor: optStr })
  .passthrough();
export const SeriesResponseSchema = z.object({ series: SeriesSchema }).passthrough();

export const PriceRangeSchema = z.object({ start: decimal, end: decimal, step: decimal }).passthrough();
export type PriceRange = { start: string; end: string; step: string };

export const MarketSchema = z
  .object({
    ticker: str,
    event_ticker: optStr,
    status: optStr,
    title: optStr,
    yes_sub_title: optStr,
    no_sub_title: optStr,
    open_time: optStr,
    close_time: optStr,
    expiration_time: optStr,
    result: optStr,
    can_close_early: z.boolean().nullish(),
    yes_bid: int.nullish(),
    yes_ask: int.nullish(),
    yes_bid_dollars: optDecimal,
    yes_ask_dollars: optDecimal,
    last_price_dollars: optDecimal,
    settlement_value_dollars: optDecimal,
    custom_strike: z.record(z.string(), z.unknown()).nullish(),
    price_level_structure: optStr,
    price_ranges: z.array(PriceRangeSchema).nullish(),
  })
  .passthrough();
export type RawMarket = z.output<typeof MarketSchema>;

export interface Market {
  ticker: string;
  event_ticker: string | null;
  status: string | null;
  yes_sub_title: string | null;
  close_time: string | null;
  result: string | null;
  yes_bid_bp: number | null;
  yes_ask_bp: number | null;
  last_price_bp: number | null;
  settlement_value_bp: number | null;
  custom_strike: Record<string, unknown> | null;
  price_level_structure: string | null;
  price_ranges: PriceRange[];
  raw: RawMarket;
}

export function toMarket(m: RawMarket): Market {
  return {
    ticker: m.ticker,
    event_ticker: m.event_ticker ?? null,
    status: m.status ?? null,
    yes_sub_title: m.yes_sub_title ?? null,
    close_time: m.close_time ?? null,
    result: m.result ?? null,
    yes_bid_bp: priceBp(m.yes_bid_dollars, m.yes_bid),
    yes_ask_bp: priceBp(m.yes_ask_dollars, m.yes_ask),
    last_price_bp: priceBp(m.last_price_dollars),
    settlement_value_bp: priceBp(m.settlement_value_dollars),
    custom_strike: m.custom_strike ?? null,
    price_level_structure: m.price_level_structure ?? null,
    price_ranges: (m.price_ranges ?? []).map((r) => ({ start: r.start, end: r.end, step: r.step })),
    raw: m,
  };
}

export const MarketResponseSchema = z.object({ market: MarketSchema }).passthrough();

export const EventSchema = z
  .object({
    event_ticker: str,
    series_ticker: optStr,
    title: optStr,
    sub_title: optStr,
    category: optStr,
    mutually_exclusive: z.boolean().nullish(),
    strike_date: optStr,
    fee_multiplier: z.number().nullish(),
    product_metadata: z.object({ competition: optStr }).passthrough().nullish(),
    markets: z.array(MarketSchema).nullish(),
  })
  .passthrough();
export type RawEvent = z.output<typeof EventSchema>;

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string | null;
  title: string | null;
  competition: string | null;
  fee_multiplier: number | null;
  markets: Market[];
}

export function toEvent(e: RawEvent, markets?: RawMarket[] | null): KalshiEvent {
  return {
    event_ticker: e.event_ticker,
    series_ticker: e.series_ticker ?? null,
    title: e.title ?? null,
    competition: e.product_metadata?.competition ?? null,
    fee_multiplier: e.fee_multiplier ?? null,
    markets: (markets ?? e.markets ?? []).map(toMarket),
  };
}

export const EventsListSchema = z
  .object({ events: z.array(EventSchema).nullish(), cursor: optStr })
  .passthrough();
export const EventResponseSchema = z
  .object({ event: EventSchema, markets: z.array(MarketSchema).nullish() })
  .passthrough();

// ---- milestones ---------------------------------------------------------------------------

export const MilestoneSchema = z
  .object({
    id: str,
    category: optStr,
    type: optStr,
    title: optStr,
    start_date: str,
    end_date: optStr,
    details: z.record(z.string(), z.unknown()).nullish(),
    primary_event_tickers: z.array(str).nullish(),
    related_event_tickers: z.array(str).nullish(),
    source_id: optStr,
    source_ids: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();
export type Milestone = z.output<typeof MilestoneSchema>;
export const MilestonesListSchema = z
  .object({ milestones: z.array(MilestoneSchema).nullish(), cursor: optStr })
  .passthrough();

// ---- orderbook ----------------------------------------------------------------------------

/** One level: `["0.0700", "50.00"]` (price dollars, size fp), or legacy `[7, 50]` (cents, contracts). */
const LevelSchema = z.union([z.tuple([decimal, decimal]), z.tuple([int, int]), z.tuple([decimal, int])]);
const SideSchema = z.array(LevelSchema).nullish();

export const OrderbookResponseSchema = z
  .object({
    orderbook_fp: z.object({ yes_dollars: SideSchema, no_dollars: SideSchema }).passthrough().nullish(),
    orderbook: z
      .object({ yes: SideSchema, no: SideSchema, yes_dollars: SideSchema, no_dollars: SideSchema })
      .passthrough()
      .nullish(),
  })
  .passthrough()
  .refine((o) => o.orderbook_fp != null || o.orderbook != null, {
    message: 'orderbook_fp or orderbook is required',
    path: ['orderbook'],
  });

export interface Level {
  price_bp: number;
  size_cc: number;
}

/** YES bids (best first) and YES asks derived from NO bids as `1 − NO bid` (best, i.e. cheapest, first). */
export interface Orderbook {
  yes_bids: Level[];
  yes_asks: Level[];
}

function toLevel(level: z.output<typeof LevelSchema>): Level {
  const [p, s] = level;
  return {
    price_bp: typeof p === 'string' ? dollarsToBp(p) : p * 100,
    size_cc: typeof s === 'string' ? fpToCc(s) : s * 100,
  };
}

export function toOrderbook(raw: z.output<typeof OrderbookResponseSchema>): Orderbook {
  const fp = raw.orderbook_fp;
  const legacy = raw.orderbook;
  const yes = fp ? fp.yes_dollars : (legacy?.yes_dollars ?? legacy?.yes);
  const no = fp ? fp.no_dollars : (legacy?.no_dollars ?? legacy?.no);
  const yes_bids = (yes ?? []).map(toLevel).sort((a, b) => b.price_bp - a.price_bp);
  const yes_asks = (no ?? [])
    .map(toLevel)
    .map((l) => ({ price_bp: 10_000 - l.price_bp, size_cc: l.size_cc }))
    .sort((a, b) => a.price_bp - b.price_bp);
  return { yes_bids, yes_asks };
}

// ---- candlesticks -------------------------------------------------------------------------

const OhlcSchema = z
  .object({
    open_dollars: optDecimal,
    high_dollars: optDecimal,
    low_dollars: optDecimal,
    close_dollars: optDecimal,
  })
  .passthrough();

export const CandlestickSchema = z
  .object({
    end_period_ts: int,
    yes_ask: OhlcSchema,
    yes_bid: OhlcSchema,
    price: OhlcSchema.nullish(),
    volume_fp: optDecimal,
    volume: int.nullish(),
  })
  .passthrough();
export const CandlesticksResponseSchema = z
  .object({ ticker: optStr, candlesticks: z.array(CandlestickSchema) })
  .passthrough();

export interface Candle {
  /** End of the 1-minute period, epoch ms. */
  end_period_ms: number;
  ask_open_bp: number | null;
  ask_high_bp: number | null;
  ask_low_bp: number | null;
  ask_close_bp: number | null;
  bid_close_bp: number | null;
  /** Null when nothing traded that minute. */
  trade_close_bp: number | null;
  volume_cc: number | null;
}

export function toCandle(c: z.output<typeof CandlestickSchema>): Candle {
  return {
    end_period_ms: c.end_period_ts * 1000,
    ask_open_bp: priceBp(c.yes_ask.open_dollars),
    ask_high_bp: priceBp(c.yes_ask.high_dollars),
    ask_low_bp: priceBp(c.yes_ask.low_dollars),
    ask_close_bp: priceBp(c.yes_ask.close_dollars),
    bid_close_bp: priceBp(c.yes_bid.close_dollars),
    trade_close_bp: priceBp(c.price?.close_dollars),
    volume_cc: countCc(c.volume_fp, c.volume),
  };
}

// ---- historical cutoff --------------------------------------------------------------------

const ts = z.union([str, z.number()]).nullish();
export const HistoricalCutoffSchema = z
  .object({
    market_settled_ts: ts,
    trades_created_ts: ts,
    orders_updated_ts: ts,
    market_positions_last_updated_ts: ts,
  })
  .passthrough();

export interface HistoricalCutoff {
  market_settled_ms: number | null;
  trades_created_ms: number | null;
  orders_updated_ms: number | null;
  market_positions_last_updated_ms: number | null;
}

export function toCutoff(c: z.output<typeof HistoricalCutoffSchema>): HistoricalCutoff {
  return {
    market_settled_ms: toEpochMs(c.market_settled_ts),
    trades_created_ms: toEpochMs(c.trades_created_ts),
    orders_updated_ms: toEpochMs(c.orders_updated_ts),
    market_positions_last_updated_ms: toEpochMs(c.market_positions_last_updated_ts),
  };
}

// ---- live data ----------------------------------------------------------------------------

export const LiveDataSchema = z
  .object({
    type: optStr,
    milestone_id: optStr,
    // `details` is an open object (SPEC.md §2): validated field by field by the tracker (T07).
    details: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export type LiveData = z.output<typeof LiveDataSchema>;
export const LiveDataResponseSchema = z.object({ live_data: LiveDataSchema }).passthrough();
export const LiveDataBatchResponseSchema = z
  .object({ live_datas: z.array(LiveDataSchema).nullish(), live_data: z.array(LiveDataSchema).nullish() })
  .passthrough();

export const GameStatsResponseSchema = z
  .object({
    pbp: z
      .object({
        periods: z.array(
          z.object({ events: z.array(z.record(z.string(), z.unknown())).nullish() }).passthrough(),
        ),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type GameStats = z.output<typeof GameStatsResponseSchema>;

// ---- orders -------------------------------------------------------------------------------

export const CreateOrderResponseSchema = z
  .object({
    order_id: str,
    client_order_id: optStr,
    fill_count: optDecimal,
    fill_count_fp: optDecimal,
    remaining_count: optDecimal,
    remaining_count_fp: optDecimal,
    average_fill_price: optDecimal,
    average_fee_paid: optDecimal,
    ts_ms: z.number().nullish(),
  })
  .passthrough();

export interface OrderResult {
  order_id: string;
  client_order_id: string | null;
  fill_cc: number;
  remaining_cc: number;
  avg_fill_price_bp: number | null;
  /** Total fee: `average_fee_paid` (per contract) × fill count, exact. */
  fee_micros: number;
  ts_ms: number | null;
}

/** `avgFeeMicros` per contract × `cc` / 100, exact (rounded up to the micro-dollar if a fractional fill leaves a remainder). */
export function totalFeeMicros(avgFeePerContractMicros: number, cc: number): number {
  const product = BigInt(avgFeePerContractMicros) * BigInt(cc);
  return Number((product + 99n) / 100n);
}

export function toOrderResult(r: z.output<typeof CreateOrderResponseSchema>): OrderResult {
  const fill_cc = fpToCc(r.fill_count ?? r.fill_count_fp ?? '0');
  const avgFee = r.average_fee_paid != null ? dollarsToMicros(r.average_fee_paid) : 0;
  return {
    order_id: r.order_id,
    client_order_id: r.client_order_id ?? null,
    fill_cc,
    remaining_cc: fpToCc(r.remaining_count ?? r.remaining_count_fp ?? '0'),
    avg_fill_price_bp: fill_cc > 0 ? priceBp(r.average_fill_price) : null,
    fee_micros: fill_cc > 0 ? totalFeeMicros(avgFee, fill_cc) : 0,
    ts_ms: r.ts_ms ?? null,
  };
}

export const OrderSchema = z
  .object({
    order_id: str,
    client_order_id: optStr,
    ticker: str,
    status: optStr,
    side: optStr,
    action: optStr,
    created_time: optStr,
    last_update_time: optStr,
    fill_count_fp: optDecimal,
    remaining_count_fp: optDecimal,
    yes_price_dollars: optDecimal,
    taker_fill_cost_dollars: optDecimal,
    taker_fees_dollars: optDecimal,
    order_group_id: optStr,
  })
  .passthrough();

export interface Order {
  order_id: string;
  client_order_id: string | null;
  ticker: string;
  status: string | null;
  created_time: string | null;
  fill_cc: number;
  remaining_cc: number | null;
  yes_price_bp: number | null;
  taker_fill_cost_micros: number | null;
  taker_fees_micros: number | null;
}

export function toOrder(o: z.output<typeof OrderSchema>): Order {
  return {
    order_id: o.order_id,
    client_order_id: o.client_order_id ?? null,
    ticker: o.ticker,
    status: o.status ?? null,
    created_time: o.created_time ?? null,
    fill_cc: countCc(o.fill_count_fp) ?? 0,
    remaining_cc: countCc(o.remaining_count_fp),
    yes_price_bp: priceBp(o.yes_price_dollars),
    taker_fill_cost_micros: moneyMicros(o.taker_fill_cost_dollars),
    taker_fees_micros: moneyMicros(o.taker_fees_dollars),
  };
}

export const OrdersListSchema = z
  .object({ orders: z.array(OrderSchema).nullish(), cursor: optStr })
  .passthrough();

// ---- portfolio ----------------------------------------------------------------------------

export const PositionSchema = z
  .object({
    ticker: str,
    position_fp: optDecimal,
    position: int.nullish(),
    market_exposure_dollars: optDecimal,
    realized_pnl_dollars: optDecimal,
    fees_paid_dollars: optDecimal,
  })
  .passthrough();
export const PositionsListSchema = z
  .object({ market_positions: z.array(PositionSchema).nullish(), cursor: optStr })
  .passthrough();

export interface Position {
  ticker: string;
  position_cc: number;
  market_exposure_micros: number | null;
  realized_pnl_micros: number | null;
  fees_paid_micros: number | null;
}

export function toPosition(p: z.output<typeof PositionSchema>): Position {
  return {
    ticker: p.ticker,
    position_cc: countCc(p.position_fp, p.position) ?? 0,
    market_exposure_micros: moneyMicros(p.market_exposure_dollars),
    realized_pnl_micros: moneyMicros(p.realized_pnl_dollars),
    fees_paid_micros: moneyMicros(p.fees_paid_dollars),
  };
}

export const SettlementSchema = z
  .object({
    ticker: str,
    market_result: optStr,
    settled_time: optStr,
    revenue: int.nullish(),
    revenue_dollars: optDecimal,
    yes_count_fp: optDecimal,
    no_count_fp: optDecimal,
    value: int.nullish(),
    value_dollars: optDecimal,
  })
  .passthrough();
export const SettlementsListSchema = z
  .object({ settlements: z.array(SettlementSchema).nullish(), cursor: optStr })
  .passthrough();

export interface Settlement {
  ticker: string;
  market_result: string | null;
  settled_time: string | null;
  revenue_micros: number | null;
  yes_count_cc: number | null;
  settlement_value_bp: number | null;
}

export function toSettlement(s: z.output<typeof SettlementSchema>): Settlement {
  return {
    ticker: s.ticker,
    market_result: s.market_result ?? null,
    settled_time: s.settled_time ?? null,
    revenue_micros: moneyMicros(s.revenue_dollars, s.revenue),
    yes_count_cc: countCc(s.yes_count_fp),
    settlement_value_bp: priceBp(s.value_dollars, s.value),
  };
}

export const FillSchema = z
  .object({
    fill_id: optStr,
    trade_id: optStr,
    order_id: str,
    client_order_id: optStr,
    ticker: str,
    side: optStr,
    action: optStr,
    count_fp: optDecimal,
    yes_price_dollars: optDecimal,
    is_taker: z.boolean().nullish(),
    fee_cost: optDecimal,
    created_time: optStr,
  })
  .passthrough();
export const FillsListSchema = z
  .object({ fills: z.array(FillSchema).nullish(), cursor: optStr })
  .passthrough();

export interface Fill {
  fill_id: string | null;
  order_id: string;
  client_order_id: string | null;
  ticker: string;
  count_cc: number;
  yes_price_bp: number | null;
  fee_micros: number | null;
  created_time: string | null;
}

export function toFill(f: z.output<typeof FillSchema>): Fill {
  return {
    fill_id: f.fill_id ?? null,
    order_id: f.order_id,
    client_order_id: f.client_order_id ?? null,
    ticker: f.ticker,
    count_cc: countCc(f.count_fp) ?? 0,
    yes_price_bp: priceBp(f.yes_price_dollars),
    fee_micros: moneyMicros(f.fee_cost),
    created_time: f.created_time ?? null,
  };
}

// ---- order groups / account ---------------------------------------------------------------

export const CreateOrderGroupResponseSchema = z.object({ order_group_id: str }).passthrough();
export const OrderGroupResponseSchema = z
  .object({ is_auto_cancel_enabled: z.boolean().nullish(), orders: z.array(z.unknown()).nullish() })
  .passthrough();
export type OrderGroup = z.output<typeof OrderGroupResponseSchema>;
export const EmptyResponseSchema = z.object({}).passthrough();
