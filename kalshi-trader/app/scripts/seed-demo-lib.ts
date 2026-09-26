/**
 * The demo-data generator behind `npm run seed:demo` (T10): strategies and trades in **both** modes with
 * attempts, bankroll and balance snapshots, spread over the last 120 days, for manual checks of the Dashboard
 * and the Trades page and for the size and speed checks of `GET /api/stats`. Deterministic for a given seed.
 * Every generated id starts with `demo-`, so `clearDemo` removes exactly what it inserted.
 */
import type Database from 'better-sqlite3';

export interface DemoOptions {
  trades: number;
  /** Clock the history ends at (epoch ms). */
  now?: number;
  seed?: number;
  kalshiEnv?: 'demo' | 'prod';
}

export interface DemoResult {
  strategies: number;
  trades: number;
  attempts: number;
  bankrollSnapshots: number;
  balanceSnapshots: number;
}

const STRATEGIES = [
  { id: 'demo-soccer-lead', name: 'Demo soccer 2-goal lead', sport: 'soccer', leagues: ['epl', 'laliga'] },
  {
    id: 'demo-soccer-late',
    name: 'Demo soccer late lead',
    sport: 'soccer',
    leagues: ['bundesliga', 'seriea', 'ligue1'],
  },
  { id: 'demo-nhl-lead', name: 'Demo NHL 2-goal lead', sport: 'hockey', leagues: ['nhl'] },
] as const;

const SKIP_REASONS = ['price', 'liquidity', 'stale_feed', 'min_price', 'market_closed', 'too_small'] as const;
const DAY_MS = 86_400_000;

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Removes every row the generator inserted. */
export function clearDemo(db: Database.Database): void {
  db.transaction(() => {
    db.prepare("DELETE FROM trade_attempts WHERE trade_id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM bankroll_snapshots WHERE trade_id LIKE 'demo-%'").run();
    // Generated balance snapshots carry subaccount 99, which the app never uses.
    db.prepare('DELETE FROM balance_snapshots WHERE subaccount = 99').run();
    db.prepare("DELETE FROM trades WHERE id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM strategy_versions WHERE strategy_id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM strategies WHERE id LIKE 'demo-%'").run();
  })();
}

/** Inserts `trades` generated trades (after removing earlier demo rows) in one transaction. */
export function seedDemo(db: Database.Database, opts: DemoOptions): DemoResult {
  const rnd = prng(opts.seed ?? 42);
  const now = opts.now ?? Date.now();
  const env = opts.kalshiEnv ?? 'demo';
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const iso = (ms: number) => new Date(ms).toISOString();
  const result: DemoResult = {
    strategies: 0,
    trades: 0,
    attempts: 0,
    bankrollSnapshots: 0,
    balanceSnapshots: 0,
  };

  clearDemo(db);
  const insStrategy = db.prepare(
    `INSERT INTO strategies (id, name, sport, mode, kill_switch, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
  );
  const insVersion = db.prepare(
    `INSERT INTO strategy_versions (strategy_id, version, league_ids, rule, sizing, execution, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
  );
  const insTrade = db.prepare(
    `INSERT INTO trades (id, strategy_id, strategy_version, game_id, market_ticker, league_id, kalshi_env,
       configured_mode, effective_mode, mode_reason, status, skip_reason, window_expired, attempts,
       trigger_snapshot, triggered_at, window_ends_at, balance_micros, stake_micros, limit_price_bp, requested_cc,
       fill_cc, avg_fill_price_bp, cost_micros, fee_micros, settled_at, settlement_value_bp, payout_micros,
       realized_pnl_micros)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insAttempt = db.prepare(
    `INSERT INTO trade_attempts (trade_id, attempt_no, at, effective_mode, mode_reason, client_order_id, status,
       reason, best_ask_bp, depth_cc, limit_price_bp, requested_cc, fill_cc, avg_fill_price_bp, fee_micros)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insBankroll = db.prepare(
    'INSERT INTO bankroll_snapshots (at, trade_id, reason, bankroll_micros) VALUES (?, ?, ?, ?)',
  );
  const insBalance = db.prepare(
    `INSERT INTO balance_snapshots (at, kalshi_env, subaccount, cash_micros, portfolio_value_micros)
     VALUES (?, ?, 99, ?, ?)`,
  );

  db.transaction(() => {
    const created = iso(now - 150 * DAY_MS);
    for (const s of STRATEGIES) {
      insStrategy.run(s.id, s.name, s.sport, 'live', created, created);
      insVersion.run(
        s.id,
        JSON.stringify(s.leagues),
        JSON.stringify({
          type: 'lead_at_time',
          version: 1,
          minLead: 2,
          atMinute: s.sport === 'hockey' ? 45 : 70,
          windowMinutes: 5,
          leaderSide: 'any',
        }),
        JSON.stringify({ type: 'percent_of_balance', percent: 2, minStakeUsd: 1, maxStakeUsd: 50 }),
        JSON.stringify({
          orderType: 'ioc_limit',
          maxPrice: 0.97,
          minPrice: null,
          maxSlippage: 0.01,
          minDepthContracts: 20,
          maxFeedAgeSec: 15,
        }),
        created,
      );
      result.strategies += 1;
    }

    let bankroll = 100_000_000;
    let cash = 250_000_000;
    const bankrollEvents: { at: number; tradeId: string; reason: string; delta: number }[] = [];
    for (let i = 0; i < opts.trades; i++) {
      const s = pick(STRATEGIES);
      const league = pick(s.leagues);
      const id = `demo-${String(i).padStart(6, '0')}`;
      const game = `DEMO-${league.toUpperCase()}-${String(i).padStart(6, '0')}`;
      const triggered = now - Math.floor(rnd() * 120 * DAY_MS);
      const live = rnd() < 0.4;
      const forced = !live && rnd() < 0.25;
      const effective = live ? 'live' : 'dry_run';
      const configured = live || forced ? 'live' : 'dry_run';
      const reason = live ? null : forced ? pick(['global_dry_run', 'addon_lock']) : 'addon_lock';
      const minute = s.sport === 'hockey' ? 45 + Math.floor(rnd() * 5) : 70 + Math.floor(rnd() * 5);
      const roll = rnd();
      const status =
        roll < 0.12
          ? 'skipped'
          : roll < 0.16
            ? 'waiting'
            : roll < 0.24
              ? 'filled'
              : roll < 0.86
                ? 'settled_won'
                : roll < 0.98
                  ? 'settled_lost'
                  : 'settled_void';
      const hasFill = status === 'filled' || status.startsWith('settled_');
      const bp = 8800 + Math.floor(rnd() * 9) * 100;
      const cc = hasFill ? (1 + Math.floor(rnd() * 3)) * 100 : null;
      const cost = cc === null ? null : cc * bp;
      const fee = cc === null ? null : Math.ceil((7 * cc * bp * (10_000 - bp)) / 1_000_000 / 100) * 100;
      const settledAt = status.startsWith('settled_') ? triggered + 2 * 3_600_000 : null;
      const value =
        status === 'settled_won'
          ? 10_000
          : status === 'settled_lost'
            ? 0
            : status === 'settled_void'
              ? 5000
              : null;
      const payout = value === null || cc === null ? null : cc * value;
      const pnl = payout === null || cost === null || fee === null ? null : payout - cost - fee;
      const skip = status === 'skipped' || status === 'waiting' ? pick(SKIP_REASONS) : null;
      const snapshot = JSON.stringify({
        gameId: game,
        leagueId: league,
        homeTeam: 'Home',
        awayTeam: 'Away',
        homeScore: 2,
        awayScore: 0,
        phase: 'live',
        clock: { minute, minuteSource: 'feed', regulationOver: false },
        blocked: false,
        source: 'demo',
        observedAt: iso(triggered),
        feedUpdatedAt: iso(triggered),
        side: 'home',
        minute,
        orderbook: { at: iso(triggered), bestAskBp: bp - 100, bestBidBp: bp - 200, askDepthCc: 5000 },
      });
      const attempts = 1 + Math.floor(rnd() * 3);
      insTrade.run(
        id,
        s.id,
        game,
        `${game}-HOME`,
        league,
        env,
        configured,
        effective,
        reason,
        status,
        skip,
        status === 'skipped' && rnd() < 0.5 ? 1 : 0,
        attempts,
        snapshot,
        iso(triggered),
        iso(triggered + 6 * 60_000),
        hasFill ? 100_000_000 : null,
        hasFill ? 2_000_000 : null,
        hasFill ? bp : null,
        cc,
        cc,
        hasFill ? bp : null,
        cost,
        fee,
        settledAt === null ? null : iso(settledAt),
        value,
        payout,
        pnl,
      );
      result.trades += 1;
      for (let n = 1; n <= attempts; n++) {
        const last = n === attempts;
        const aStatus =
          last && hasFill
            ? 'filled'
            : last && status === 'skipped' && rnd() < 0.3
              ? 'hard_skip'
              : 'soft_skip';
        insAttempt.run(
          id,
          n,
          iso(triggered + (n - 1) * 5000),
          effective,
          reason,
          `${id}-${n}`,
          aStatus,
          aStatus === 'filled' ? null : (skip ?? pick(SKIP_REASONS)),
          bp - 100,
          5000,
          bp,
          cc,
          aStatus === 'filled' ? cc : null,
          aStatus === 'filled' ? bp : null,
          aStatus === 'filled' ? fee : null,
        );
        result.attempts += 1;
      }
      if (!live && cost !== null && fee !== null) {
        bankrollEvents.push({ at: triggered, tradeId: id, reason: 'fill', delta: -(cost + fee) });
        if (settledAt !== null && payout !== null)
          bankrollEvents.push({ at: settledAt, tradeId: id, reason: 'settlement', delta: payout });
      }
      if (live && pnl !== null) cash += pnl;
    }
    bankrollEvents.sort((a, b) => a.at - b.at);
    for (const e of bankrollEvents) {
      bankroll += e.delta;
      insBankroll.run(iso(e.at), e.tradeId, e.reason, bankroll);
      result.bankrollSnapshots += 1;
    }
    // One live balance snapshot a day (the final value reflects the generated live P&L).
    for (let d = 120; d >= 0; d--) {
      const c = cash - Math.floor((d * (cash - 250_000_000)) / 120);
      insBalance.run(iso(now - d * DAY_MS), env, c, c + 1_500_000);
      result.balanceSnapshots += 1;
    }
  })();
  return result;
}
