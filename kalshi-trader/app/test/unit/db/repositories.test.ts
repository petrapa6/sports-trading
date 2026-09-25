import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepositories, ValidationError, type Repositories } from '../../../src/db/repositories.js';
import type { NewTrade, NewTradeAttempt } from '../../../src/db/schema.js';
import { SETTING_KEYS, SettingsError } from '../../../src/db/settings.js';
import { tempDb, type TempDb } from '../../helpers/db.js';

const AT = '2026-09-25T19:04:11.512Z';

function trade(over: Partial<NewTrade> = {}): NewTrade {
  return {
    id: 'tr-1',
    strategy_id: 'st-1',
    strategy_version: 1,
    game_id: 'KXEPLGAME-26FEB07WOLCFC',
    league_id: 'epl',
    kalshi_env: 'demo',
    configured_mode: 'dry_run',
    effective_mode: 'dry_run',
    status: 'signalled',
    trigger_snapshot: '{}',
    triggered_at: AT,
    window_ends_at: AT,
    ...over,
  };
}

function attempt(over: Partial<NewTradeAttempt> = {}): NewTradeAttempt {
  return {
    trade_id: 'tr-1',
    attempt_no: 1,
    at: AT,
    effective_mode: 'dry_run',
    client_order_id: 'tr-1-1',
    status: 'pending',
    ...over,
  };
}

describe('repositories', () => {
  let t: TempDb;
  let r: Repositories;
  beforeEach(() => {
    t = tempDb();
    r = createRepositories(t.db.orm, () => Date.parse(AT));
  });
  afterEach(() => t.cleanup());

  describe('trades and trade_attempts', () => {
    it('reject a second trade for the same (strategy_id, game_id)', () => {
      r.trades.insert(trade());
      expect(() => r.trades.insert(trade({ id: 'tr-2' }))).toThrow(
        /UNIQUE constraint failed: trades.strategy_id, trades.game_id/,
      );
      expect(r.trades.findByStrategyAndGame('st-1', 'KXEPLGAME-26FEB07WOLCFC')?.id).toBe('tr-1');
    });

    it('reject a second attempt with the same client_order_id', () => {
      r.trades.insert(trade());
      r.trades.insert(trade({ id: 'tr-2', game_id: 'other' }));
      r.tradeAttempts.insert(attempt());
      expect(() => r.tradeAttempts.insert(attempt({ trade_id: 'tr-2', attempt_no: 1 }))).toThrow(
        /UNIQUE constraint failed: trade_attempts.client_order_id/,
      );
    });

    it('reject a second attempt with the same (trade_id, attempt_no)', () => {
      r.trades.insert(trade());
      r.tradeAttempts.insert(attempt());
      expect(() => r.tradeAttempts.insert(attempt({ client_order_id: 'x' }))).toThrow(
        /UNIQUE constraint failed/,
      );
    });

    it('reject an attempt for an unknown trade (foreign key)', () => {
      expect(() => r.tradeAttempts.insert(attempt({ trade_id: 'nope' }))).toThrow(/FOREIGN KEY/);
    });

    it('trades CRUD', () => {
      const row = r.trades.insert(trade({ stake_micros: 5_000_000, limit_price_bp: 9300 }));
      expect(row.attempts).toBe(0);
      expect(row.window_expired).toBe(0);
      expect(r.trades.get({ id: 'tr-1' })?.stake_micros).toBe(5_000_000);
      const upd = r.trades.update({ id: 'tr-1' }, { status: 'filled', fill_cc: 200, cost_micros: 1_860_000 });
      expect(upd).toMatchObject({ status: 'filled', fill_cc: 200, cost_micros: 1_860_000 });
      expect(r.trades.count()).toBe(1);
      expect(r.trades.delete({ id: 'tr-1' })).toBe(true);
      expect(r.trades.get({ id: 'tr-1' })).toBeUndefined();
    });

    it('trade_attempts CRUD', () => {
      r.trades.insert(trade());
      const a = r.tradeAttempts.insert(attempt());
      r.tradeAttempts.insert(attempt({ attempt_no: 2, client_order_id: 'tr-1-2' }));
      expect(r.tradeAttempts.listForTrade('tr-1').map((x) => x.attempt_no)).toEqual([1, 2]);
      expect(r.tradeAttempts.findByClientOrderId('tr-1-2')?.attempt_no).toBe(2);
      expect(r.tradeAttempts.update({ id: a.id }, { status: 'filled', fill_cc: 100 })?.status).toBe('filled');
      expect(r.tradeAttempts.delete({ id: a.id })).toBe(true);
      expect(r.tradeAttempts.count()).toBe(1);
    });
  });

  describe('validation of money, price and count columns', () => {
    it('rejects a fractional stake_micros', () => {
      expect(() => r.trades.insert(trade({ stake_micros: 12.5 }))).toThrow(ValidationError);
      expect(() => r.trades.insert(trade({ stake_micros: 12.5 }))).toThrow(
        /trades.stake_micros must be a safe integer/,
      );
      expect(r.trades.count()).toBe(0);
    });

    it('rejects a string fill_cc', () => {
      expect(() => r.trades.insert(trade({ fill_cc: '200' as unknown as number }))).toThrow(/trades.fill_cc/);
      r.trades.insert(trade());
      expect(() => r.trades.update({ id: 'tr-1' }, { fill_cc: '200' as unknown as number })).toThrow(
        ValidationError,
      );
      expect(r.trades.get({ id: 'tr-1' })?.fill_cc).toBeNull();
    });

    it('rejects unsafe integers, NaN and unknown columns', () => {
      expect(() => r.trades.insert(trade({ cost_micros: 2 ** 53 }))).toThrow(ValidationError);
      expect(() => r.trades.insert(trade({ limit_price_bp: Number.NaN }))).toThrow(ValidationError);
      expect(() => r.trades.insert({ ...trade(), bogus: 1 } as NewTrade)).toThrow(
        /trades.bogus is not a column/,
      );
      expect(() => r.backtestTrades.insert({ pnl_micros: 0.1 })).toThrow(/backtest_trades.pnl_micros/);
      expect(() => r.histPrices.insert({ market_ticker: 'M', minute_ts: AT, volume_cc: 1.5 })).toThrow(
        ValidationError,
      );
      expect(() => r.bankrollSnapshots.insert({ at: AT, reason: 'fill', bankroll_micros: 1e20 })).toThrow(
        ValidationError,
      );
    });

    it('rejects a non-string in a text column', () => {
      expect(() => r.trades.insert(trade({ status: 1 as unknown as string }))).toThrow(
        /trades.status must be a string/,
      );
    });

    it('accepts negative integers (P&L) and null', () => {
      const row = r.trades.insert(trade({ realized_pnl_micros: -1_860_000, fee_micros: null }));
      expect(row.realized_pnl_micros).toBe(-1_860_000);
    });
  });

  describe('settings', () => {
    it('returns the §7 defaults on an empty table', () => {
      expect(r.settings.get('global_dry_run')).toBe(true);
      expect(r.settings.get('global_kill_switch')).toBe(false);
      expect(r.settings.getAll()).toEqual({
        global_kill_switch: false,
        global_dry_run: true,
        dry_run_bankroll_micros: 100_000_000,
        dry_run_initial_bankroll_micros: 100_000_000,
        fee_balance_precision_micros: 100,
        kalshi_order_group_id: null,
        order_group_contract_limit: 200,
        price_model: null,
        api_football_key_enc: null,
        notifications: {},
      });
      expect(t.db.sqlite.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 });
    });

    it('set/get round-trips JSON values', () => {
      r.settings.set('global_dry_run', false);
      r.settings.set('dry_run_bankroll_micros', 123_456_789);
      r.settings.set('kalshi_order_group_id', 'og-1');
      const model = { version: 2, buckets: [{ minute: 80, lead: 1, p: '0.93' }], note: null };
      r.settings.set('price_model', model);
      r.settings.set('notifications', { onFill: true, targets: ['mobile_app_pixel'] });
      expect(r.settings.get('global_dry_run')).toBe(false);
      expect(r.settings.get('dry_run_bankroll_micros')).toBe(123_456_789);
      expect(r.settings.get('kalshi_order_group_id')).toBe('og-1');
      expect(r.settings.get('price_model')).toEqual(model);
      expect(r.settings.get('notifications')).toEqual({ onFill: true, targets: ['mobile_app_pixel'] });
      const raw = t.db.sqlite
        .prepare("SELECT value, updated_at FROM settings WHERE key = 'global_dry_run'")
        .get();
      expect(raw).toEqual({ value: 'false', updated_at: AT });
      r.settings.set('global_dry_run', true);
      expect(r.settings.get('global_dry_run')).toBe(true);
      r.settings.reset('global_dry_run');
      expect(r.settings.get('global_dry_run')).toBe(true);
    });

    it('validates values and keys', () => {
      expect(() => r.settings.set('dry_run_bankroll_micros', 12.5)).toThrow(SettingsError);
      expect(() => r.settings.set('global_dry_run', 'yes' as unknown as boolean)).toThrow(SettingsError);
      expect(() => r.settings.set('fee_balance_precision_micros', 300)).toThrow(SettingsError);
      r.settings.set('fee_balance_precision_micros', 10_000);
      expect(() => r.settings.get('nope' as never)).toThrow(/unknown setting/);
      expect(SETTING_KEYS).toHaveLength(10);
    });

    it('rejects a corrupt stored value', () => {
      t.db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('global_dry_run', '\"maybe\"')").run();
      expect(() => r.settings.get('global_dry_run')).toThrow(SettingsError);
    });
  });

  describe('CRUD for every other table', () => {
    it('leagues', () => {
      expect(r.leagues.count()).toBe(6);
      expect(r.leagues.listEnabled()).toHaveLength(6);
      expect(r.leagues.update({ id: 'nhl' }, { include_preseason: 1 })?.include_preseason).toBe(1);
      r.leagues.insert({
        id: 'mls',
        sport: 'soccer',
        name: 'MLS',
        kalshi_series: 'KXMLSGAME',
        feed_ids: '{}',
        enabled: 0,
      });
      expect(r.leagues.get({ id: 'mls' })?.include_preseason).toBe(0);
      expect(r.leagues.listEnabled()).toHaveLength(6);
      expect(r.leagues.delete({ id: 'mls' })).toBe(true);
    });

    it('teams', () => {
      r.teams.insert({ id: 'wol', league_id: 'epl', name: 'Wolves', aliases: '["WOL"]' });
      expect(r.teams.listByLeague('epl').map((x) => x.id)).toEqual(['wol']);
      expect(r.teams.update({ id: 'wol' }, { abbreviation: 'WOL' })?.abbreviation).toBe('WOL');
      expect(() => r.teams.insert({ id: 'x', league_id: 'nope', name: 'X' })).toThrow(/FOREIGN KEY/);
      expect(r.teams.delete({ id: 'wol' })).toBe(true);
    });

    it('games and markets', () => {
      const g = r.games.insert({
        id: 'KXEPLGAME-26FEB07WOLCFC',
        league_id: 'epl',
        scheduled_at: AT,
        updated_at: AT,
      });
      expect(g.phase).toBe('scheduled');
      expect(g.timeline_archived).toBe(0);
      r.markets.insert({
        ticker: 'KXEPLGAME-26FEB07WOLCFC-WOL',
        game_id: g.id,
        outcome: 'home',
        yes_ask_bp: 9300,
      });
      expect(r.markets.listByGame(g.id)).toHaveLength(1);
      expect(
        r.markets.update({ ticker: 'KXEPLGAME-26FEB07WOLCFC-WOL' }, { settlement_value_bp: 10_000 })
          ?.settlement_value_bp,
      ).toBe(10_000);
      expect(r.games.update({ id: g.id }, { home_score: 1, phase: 'first_half' })?.home_score).toBe(1);
      expect(r.games.listByLeague('epl')).toHaveLength(1);
      expect(r.markets.delete({ ticker: 'KXEPLGAME-26FEB07WOLCFC-WOL' })).toBe(true);
      expect(r.games.delete({ id: g.id })).toBe(true);
    });

    it('game_snapshots', () => {
      const a = r.gameSnapshots.insert({
        game_id: 'g',
        observed_at: '2026-09-25T19:05:00.000Z',
        feed: 'kalshi',
      });
      r.gameSnapshots.insert({ game_id: 'g', observed_at: '2026-09-25T19:04:00.000Z', feed: 'kalshi' });
      expect(r.gameSnapshots.listByGame('g').map((x) => x.observed_at)).toEqual([
        '2026-09-25T19:04:00.000Z',
        '2026-09-25T19:05:00.000Z',
      ]);
      expect(r.gameSnapshots.update({ id: a.id }, { home_score: 2 })?.home_score).toBe(2);
      expect(r.gameSnapshots.delete({ id: a.id })).toBe(true);
      expect(r.gameSnapshots.count()).toBe(1);
    });

    it('strategies and strategy_versions', () => {
      const st = r.strategies.insert({
        id: 'st-1',
        name: 'Lead 2 @ 80',
        sport: 'soccer',
        current_version: 1,
      });
      expect(st.mode).toBe('dry_run');
      expect(st.kill_switch).toBe(1);
      expect(() =>
        r.strategies.insert({ id: 'st-2', name: 'x', sport: 'soccer', mode: 'paper', current_version: 1 }),
      ).toThrow(/CHECK constraint/);
      const v = { strategy_id: 'st-1', league_ids: '["epl"]', rule: '{}', sizing: '{}', execution: '{}' };
      r.strategyVersions.insert({ ...v, version: 1 });
      r.strategyVersions.insert({ ...v, version: 2 });
      expect(() => r.strategyVersions.insert({ ...v, version: 2 })).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(r.strategyVersions.get({ strategy_id: 'st-1', version: 2 })?.version).toBe(2);
      expect(r.strategyVersions.listForStrategy('st-1')).toHaveLength(2);
      expect(r.strategyVersions.update({ strategy_id: 'st-1', version: 2 }, { rule: '{"a":1}' })?.rule).toBe(
        '{"a":1}',
      );
      expect(r.strategies.update({ id: 'st-1' }, { mode: 'live', current_version: 2 })?.mode).toBe('live');
      expect(r.strategyVersions.delete({ strategy_id: 'st-1', version: 1 })).toBe(true);
      expect(() => r.strategies.delete({ id: 'st-1' })).toThrow(/FOREIGN KEY/);
    });

    it('balance_snapshots and bankroll_snapshots', () => {
      const b = r.balanceSnapshots.insert({
        at: AT,
        kalshi_env: 'demo',
        subaccount: 0,
        cash_micros: 50_000_000,
      });
      expect(r.balanceSnapshots.get({ id: b.id })?.cash_micros).toBe(50_000_000);
      expect(
        r.balanceSnapshots.update({ id: b.id }, { portfolio_value_micros: 1 })?.portfolio_value_micros,
      ).toBe(1);
      expect(r.balanceSnapshots.delete({ id: b.id })).toBe(true);
      const k = r.bankrollSnapshots.insert({ at: AT, reason: 'reset', bankroll_micros: 100_000_000 });
      expect(r.bankrollSnapshots.list()).toHaveLength(1);
      expect(r.bankrollSnapshots.update({ id: k.id }, { bankroll_micros: 99 })?.bankroll_micros).toBe(99);
      expect(r.bankrollSnapshots.delete({ id: k.id })).toBe(true);
    });

    it('audit_log', () => {
      const a = r.auditLog.insert({
        at: AT,
        actor: 'system',
        action: 'settings.update',
        mode: null,
        detail: '{}',
      });
      expect(r.auditLog.get({ id: a.id })?.action).toBe('settings.update');
      expect(r.auditLog.update({ id: a.id }, { entity: 'settings' })?.entity).toBe('settings');
      expect(r.auditLog.delete({ id: a.id })).toBe(true);
    });

    it('users, sessions and login_attempts', () => {
      const u = r.users.insert({ username: 'pavel', password_hash: '$argon2id$x' });
      expect(() => r.users.insert({ username: 'pavel', password_hash: 'y' })).toThrow(/UNIQUE/);
      expect(r.users.findByUsername('pavel')?.id).toBe(u.id);
      expect(r.users.update({ id: u.id }, { last_login_at: AT })?.last_login_at).toBe(AT);
      const sess = {
        user_id: u.id,
        channel: 'dev',
        created_at: AT,
        last_seen_at: AT,
        last_auth_at: AT,
        expires_at: AT,
      };
      r.sessions.insert({ id_hash: 'abc', ...sess });
      expect(r.sessions.get({ id_hash: 'abc' })?.user_id).toBe(u.id);
      expect(r.sessions.update({ id_hash: 'abc' }, { ip: '127.0.0.1' })?.ip).toBe('127.0.0.1');
      expect(r.sessions.delete({ id_hash: 'abc' })).toBe(true);
      const l = r.loginAttempts.insert({ at: AT, username: 'pavel', ok: 0 });
      expect(r.loginAttempts.update({ id: l.id }, { ok: 1 })?.ok).toBe(1);
      expect(r.loginAttempts.delete({ id: l.id })).toBe(true);
      expect(r.users.delete({ id: u.id })).toBe(true);
    });

    it('hist_games, hist_prices, backtests and backtest_trades', () => {
      r.histGames.insert({ id: 'h1', league_id: 'epl', season: '2025', goal_events: '[]', source: 'csv' });
      expect(r.histGames.update({ id: 'h1' }, { final_home: 2 })?.final_home).toBe(2);
      r.histPrices.insert({ market_ticker: 'M', minute_ts: AT, ask_close_bp: 9300, volume_cc: 1500 });
      expect(() => r.histPrices.insert({ market_ticker: 'M', minute_ts: AT })).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(r.histPrices.get({ market_ticker: 'M', minute_ts: AT })?.ask_close_bp).toBe(9300);
      expect(
        r.histPrices.update({ market_ticker: 'M', minute_ts: AT }, { trade_close_bp: 9400 })?.trade_close_bp,
      ).toBe(9400);
      r.backtests.insert({ id: 'b1', price_mode: 'exact', initial_bankroll_micros: 100_000_000 });
      const bt = r.backtestTrades.insert({
        backtest_id: 'b1',
        hist_game_id: 'h1',
        price_bp: 9300,
        pnl_micros: -5200,
      });
      expect(r.backtestTrades.list().map((x) => x.pnl_micros)).toEqual([-5200]);
      expect(r.backtests.update({ id: 'b1' }, { result_summary: '{}' })?.result_summary).toBe('{}');
      expect(r.backtestTrades.delete({ id: bt.id })).toBe(true);
      expect(r.backtests.delete({ id: 'b1' })).toBe(true);
      expect(r.histPrices.delete({ market_ticker: 'M', minute_ts: AT })).toBe(true);
      expect(r.histGames.delete({ id: 'h1' })).toBe(true);
    });

    it('insertMany is all-or-nothing', () => {
      expect(() =>
        r.auditLog.insertMany([
          { at: AT, actor: 'system', action: 'a' },
          { at: AT, actor: 'system', action: null as unknown as string },
        ]),
      ).toThrow(/NOT NULL/);
      expect(r.auditLog.count()).toBe(0);
      expect(r.auditLog.insertMany([{ at: AT, actor: 'system', action: 'a' }])).toBe(1);
    });
  });
});
