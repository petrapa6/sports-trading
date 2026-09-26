/**
 * The body of `npm run e2e:demo` (SPEC.md §14 T13): one real IOC order for 1 contract on the cheapest open
 * market of the Kalshi **demo** environment, recorded like a live trade of the app (trade + attempt rows,
 * `pending` before the request, audit rows, `effective_mode = 'live'`, `kalshi_env = 'demo'`), read back with
 * `getOrders` by `client_order_id`, and the exchange's fee compared with `feeMicros` at both balance precisions
 * ($0.0001 = 100 and $0.01 = 10 000 micro-dollars, SPEC.md §2 Fees).
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { feeMicros, toMultiplierMilli } from '../src/core/pricing.js';
import { OrderGroupManager } from '../src/core/orderGroup.js';
import { StrategyDefinitionSchema } from '../src/core/strategy.js';
import { createStrategy, loadStrategies } from '../src/core/strategyStore.js';
import { auditTrade, transitionTrade, updateAttempt } from '../src/core/trades.js';
import type { Repositories } from '../src/db/repositories.js';
import type { KalshiClient } from '../src/feeds/kalshi/client.js';
import type { Market } from '../src/feeds/kalshi/schemas.js';
import { formatMicros } from './kalshi-format.js';

export const DEMO_STRATEGY_NAME = 'Demo fee check (npm run e2e:demo)';
export const PRECISIONS = [100, 10_000] as const;

export interface DemoFeeCheck {
  tradeId: string;
  ticker: string;
  orderId: string;
  fillCc: number;
  avgFillPriceBp: number | null;
  exchangeFeeMicros: number;
  modelFeeMicros: Record<(typeof PRECISIONS)[number], number>;
  /** The precision whose formula equals the exchange's fee, or `null` (nothing filled / neither matches). */
  matches: (typeof PRECISIONS)[number] | null;
}

type DemoKalshi = Pick<
  KalshiClient,
  | 'listMarkets'
  | 'getOrderbook'
  | 'createOrderV2'
  | 'getOrders'
  | 'getSeries'
  | 'getEvent'
  | 'createOrderGroup'
  | 'getOrderGroup'
  | 'resetOrderGroup'
>;

/** The cheapest open market with at least one contract offered at its best ask (the app's series first). */
async function cheapestMarket(
  client: DemoKalshi,
  repos: Repositories,
): Promise<{ market: Market; askBp: number; leagueId: string | null }> {
  const leagues = repos.leagues.listEnabled();
  const candidates: { market: Market; leagueId: string | null }[] = [];
  for (const league of leagues) {
    const page = await client.listMarkets({ status: 'open', seriesTicker: league.kalshi_series });
    candidates.push(...page.items.map((market) => ({ market, leagueId: league.id })));
  }
  if (candidates.length === 0) {
    const page = await client.listMarkets({ status: 'open' });
    candidates.push(...page.items.map((market) => ({ market, leagueId: null })));
  }
  const priced = candidates
    .filter((c) => c.market.yes_ask_bp !== null && c.market.yes_ask_bp >= 100 && c.market.yes_ask_bp <= 9900)
    .sort((a, b) => (a.market.yes_ask_bp ?? 0) - (b.market.yes_ask_bp ?? 0));
  for (const c of priced.slice(0, 10)) {
    const book = await client.getOrderbook(c.market.ticker);
    const best = book.yes_asks[0];
    if (best && best.size_cc >= 100) return { market: c.market, askBp: best.price_bp, leagueId: c.leagueId };
  }
  throw new Error('no open demo market offers a contract at its best ask');
}

/** The strategy the demo trade is filed under (created once: kill switch on, mode live). */
function demoStrategy(
  repos: Repositories,
  leagueId: string,
  nowIso: string,
): { id: string; version: number } {
  const existing = loadStrategies(repos).find((s) => s.name === DEMO_STRATEGY_NAME);
  if (existing) return { id: existing.id, version: existing.currentVersion };
  const sport = repos.leagues.get({ id: leagueId })?.sport ?? 'hockey';
  const def = StrategyDefinitionSchema.parse({
    name: DEMO_STRATEGY_NAME,
    sport,
    leagueIds: [leagueId],
    rule: { type: 'lead_at_time', minLead: 1, atMinute: sport === 'hockey' ? 59 : 90, windowMinutes: 0 },
    sizing: { percent: 1, minStakeUsd: 1, maxStakeUsd: 1 },
    execution: { maxPrice: 0.99 },
  });
  const s = createStrategy(repos, def, nowIso);
  repos.strategies.update({ id: s.id }, { mode: 'live', kill_switch: 1 });
  return { id: s.id, version: s.currentVersion };
}

export async function runDemoFeeCheck(o: {
  client: DemoKalshi;
  repos: Repositories;
  log: Logger;
  transaction: (fn: () => void) => void;
  print: (line: string) => void;
  now?: () => number;
}): Promise<DemoFeeCheck> {
  const now = o.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const { repos, client, print } = o;

  const { market, askBp, leagueId: foundLeague } = await cheapestMarket(client, repos);
  const leagueId = foundLeague ?? repos.leagues.listEnabled()[0]?.id ?? 'nhl';
  const eventTicker = market.event_ticker ?? market.ticker.split('-').slice(0, -1).join('-');
  print(`market: ${market.ticker} (best ask ${askBp / 10_000})`);

  const groups = new OrderGroupManager({
    repos: () => repos,
    log: o.log,
    kalshi: () => client,
    allowLiveOrders: true,
  });
  const orderGroupId = await groups.ensure();
  if (orderGroupId === null) throw new Error('no order group could be created');
  print(`order group: ${orderGroupId}`);

  // The trade and its attempt exist before the order request (§4).
  const strategy = demoStrategy(repos, leagueId, iso());
  const tradeId = randomUUID();
  const at = iso();
  const snapshot = { manual: 'npm run e2e:demo', ticker: market.ticker, askBp };
  let attempt = repos.tradeAttempts.insert({
    trade_id: repos.trades.insert({
      id: tradeId,
      strategy_id: strategy.id,
      strategy_version: strategy.version,
      game_id: eventTicker,
      market_ticker: market.ticker,
      league_id: leagueId,
      kalshi_env: 'demo',
      configured_mode: 'live',
      effective_mode: 'live',
      mode_reason: null,
      status: 'signalled',
      attempts: 1,
      trigger_snapshot: JSON.stringify(snapshot),
      triggered_at: at,
      window_ends_at: new Date(now() + 60_000).toISOString(),
    }).id,
    attempt_no: 1,
    at,
    effective_mode: 'live',
    client_order_id: `${tradeId}-1`,
    status: 'pending',
    best_ask_bp: askBp,
    limit_price_bp: askBp,
    requested_cc: 100,
  });
  auditTrade(repos, at, tradeId, 'live', 'trade_signalled', {
    manual: 'e2e:demo',
    marketTicker: market.ticker,
  });
  auditTrade(repos, at, tradeId, 'live', 'attempt_pending', {
    attemptNo: 1,
    clientOrderId: attempt.client_order_id,
  });
  let trade = transitionTrade(repos, at, must(repos.trades.get({ id: tradeId })), 'pending', {
    limit_price_bp: askBp,
    requested_cc: 100,
    stake_micros: askBp * 100,
  });

  const result = await client.createOrderV2({
    ticker: market.ticker,
    contracts: 1,
    priceBp: askBp,
    clientOrderId: attempt.client_order_id,
    orderGroupId,
  });
  print(`order id: ${result.order_id}`);
  print(`fill_count: ${(result.fill_cc / 100).toFixed(2)}`);

  const avg = result.avg_fill_price_bp;
  o.transaction(() => {
    const t2 = must(repos.trades.get({ id: tradeId }));
    if (result.fill_cc > 0 && avg !== null) {
      attempt = updateAttempt(repos, iso(), attempt, {
        status: 'filled',
        fill_cc: result.fill_cc,
        avg_fill_price_bp: avg,
        fee_micros: result.fee_micros,
        kalshi_order_id: result.order_id,
        response: JSON.stringify({
          order_id: result.order_id,
          fill_cc: result.fill_cc,
          fee_micros: result.fee_micros,
        }),
      });
      trade = transitionTrade(repos, iso(), t2, 'filled', {
        fill_cc: result.fill_cc,
        avg_fill_price_bp: avg,
        cost_micros: result.fill_cc * avg,
        fee_micros: result.fee_micros,
        kalshi_order_id: result.order_id,
      });
    } else {
      attempt = updateAttempt(repos, iso(), attempt, {
        status: 'unfilled',
        reason: 'unfilled',
        fill_cc: 0,
        kalshi_order_id: result.order_id,
      });
      trade = transitionTrade(repos, iso(), t2, 'skipped', { skip_reason: 'unfilled' });
    }
  });

  // Read back by client_order_id (there is no such filter: ticker + min_ts, matched here).
  const orders = await client.getOrders({ ticker: market.ticker, minTs: Date.parse(at) - 60_000 });
  const readBack = orders.find((x) => x.client_order_id === attempt.client_order_id);
  print(
    readBack
      ? `read back: ${readBack.order_id} status ${readBack.status ?? '?'} fill ${(readBack.fill_cc / 100).toFixed(2)} ` +
          `cost ${formatMicros(readBack.taker_fill_cost_micros ?? 0)} fees ${formatMicros(readBack.taker_fees_micros ?? 0)}`
      : `read back: no order with client_order_id ${attempt.client_order_id} (yet)`,
  );

  // Fee check (§2 Fees): the exchange's fee against the formula at both precisions.
  let multiplierMilli = 1000;
  try {
    const eventM = (await client.getEvent(eventTicker)).fee_multiplier;
    const series = eventTicker.split('-')[0] ?? '';
    const m = eventM ?? (await client.getSeries(series)).fee_multiplier;
    if (m !== null && m !== undefined) multiplierMilli = toMultiplierMilli(m);
  } catch {
    // every configured series reports 1
  }
  const exchangeFee = readBack?.taker_fees_micros ?? result.fee_micros;
  const model = Object.fromEntries(
    PRECISIONS.map((p) => [
      p,
      result.fill_cc > 0 && avg !== null
        ? feeMicros({ cc: result.fill_cc, bp: avg, multiplierMilli, precisionMicros: p })
        : 0,
    ]),
  ) as DemoFeeCheck['modelFeeMicros'];
  const matches = result.fill_cc > 0 ? (PRECISIONS.find((p) => model[p] === exchangeFee) ?? null) : null;
  print(
    `fee: exchange ${formatMicros(exchangeFee)} | formula at $0.0001 ${formatMicros(model[100])} | ` +
      `formula at $0.01 ${formatMicros(model[10_000])} → ` +
      (result.fill_cc === 0
        ? 'nothing filled, no comparison'
        : matches === null
          ? 'matches neither precision'
          : `matches fee_balance_precision_micros=${matches}`),
  );
  print(`trade row id: ${trade.id} (status ${trade.status}, LIVE, demo)`);
  return {
    tradeId,
    ticker: market.ticker,
    orderId: result.order_id,
    fillCc: result.fill_cc,
    avgFillPriceBp: avg,
    exchangeFeeMicros: exchangeFee,
    modelFeeMicros: model,
    matches,
  };
}

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('row vanished');
  return v;
}
