import { afterEach, describe, expect, it } from 'vitest';
import {
  Client,
  createTestApp,
  ingress,
  PASSWORD,
  setupUser,
  USER,
  type TestApp,
} from '../../helpers/app.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const VALID = {
  name: "EPL 2-goal lead at 80'",
  sport: 'soccer',
  leagueIds: ['epl', 'laliga'],
  mode: 'dry_run',
  killSwitch: true,
  rule: { type: 'lead_at_time', version: 1, minLead: 2, atMinute: 80, windowMinutes: 5, leaderSide: 'any' },
  sizing: { type: 'percent_of_balance', percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
  execution: {
    orderType: 'ioc_limit',
    maxPrice: 0.97,
    minPrice: null,
    maxSlippage: 0.01,
    minDepthContracts: 20,
    maxFeedAgeSec: 15,
  },
};

/** `VALID` without `mode` / `killSwitch`: the body of an edit. */
const DEFINITION = Object.fromEntries(
  Object.entries(VALID).filter(([k]) => k !== 'mode' && k !== 'killSwitch'),
) as Omit<typeof VALID, 'mode' | 'killSwitch'>;

type Body = Record<string, unknown>;
const withPatch = (patch: (b: typeof VALID) => unknown): Body => {
  const b = structuredClone(VALID);
  patch(b);
  return b as unknown as Body;
};

interface StrategyJson {
  id: string;
  name: string;
  killSwitch: boolean;
  mode: 'live' | 'dry_run';
  effectiveMode: string;
  modeReason: string | null;
  currentVersion: number;
  deletedAt: string | null;
  rule: { minLead: number; windowMinutes: number };
  versions?: { version: number; rule: { minLead: number } }[];
}

async function app(runtime: { allowLiveOrders?: boolean } = {}): Promise<{ t: TestApp; c: Client }> {
  const created = await createTestApp({ runtime });
  await setupUser(created.app);
  const c = new Client(created.app, ingress());
  expect((await c.login(USER, PASSWORD)).statusCode).toBe(200);
  return { t: created, c };
}

/** Makes the session's last authentication 10 minutes old, so step-up is required again. */
function ageAuth(test: TestApp): void {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  test.manager.current?.sqlite.prepare('UPDATE sessions SET last_auth_at = ?').run(old);
}

const auditRows = (test: TestApp, action: string) =>
  test.manager.repositories.auditLog.list().filter((r) => r.action === action);

describe('validation (400 with the offending field)', () => {
  it.each<[string, Body, RegExp]>([
    ['percent: 150 → sizing.percent', withPatch((b) => (b.sizing.percent = 150)), /^sizing\.percent: /],
    ['soccer atMinute: 95', withPatch((b) => (b.rule.atMinute = 95)), /^rule\.atMinute: /],
    ['minLead: 0', withPatch((b) => (b.rule.minLead = 0)), /^rule\.minLead: /],
    [
      'minPrice ≥ maxPrice',
      withPatch((b) => ((b.execution as { minPrice: number | null }).minPrice = 0.97)),
      /^execution\.minPrice: /,
    ],
    [
      'minPrice > maxPrice',
      withPatch((b) => ((b.execution as { minPrice: number | null }).minPrice = 0.98)),
      /^execution\.minPrice: /,
    ],
    ["leagueIds: ['nba']", withPatch((b) => (b.leagueIds = ['nba'])), /^leagueIds\.0: unknown league "nba"/],
    [
      'a hockey strategy with an EPL league',
      withPatch((b) => {
        (b as { sport: string }).sport = 'hockey';
        b.leagueIds = ['nhl', 'epl'];
        b.rule.atMinute = 50;
      }),
      /^leagueIds\.1: .* is a soccer league, not hockey/,
    ],
    [
      'hockey atMinute: 60',
      withPatch((b) => {
        (b as { sport: string }).sport = 'hockey';
        b.leagueIds = ['nhl'];
        b.rule.atMinute = 60;
      }),
      /^rule\.atMinute: /,
    ],
    [
      'maxPrice with 5 decimals',
      withPatch((b) => (b.execution.maxPrice = 0.97001)),
      /^execution\.maxPrice: /,
    ],
    ['an unknown field', withPatch((b) => ((b as unknown as Body)['extra'] = 1)), /unrecognized/i],
    ['a new strategy in live', withPatch((b) => ((b as { mode: string }).mode = 'live')), /^mode: /],
    [
      'a new strategy with the kill switch off',
      withPatch((b) => ((b as { killSwitch: boolean }).killSwitch = false)),
      /^killSwitch: /,
    ],
  ])('%s', async (_label, body, issue) => {
    const s = await app();
    t = s.t;
    const res = await s.c.postWithCsrf('/api/strategies', body);
    expect(res.statusCode, res.body).toBe(400);
    const json = res.json() as { error: string; issues: string[] };
    expect(json.error).toBe('bad_request');
    expect(
      json.issues.some((i) => issue.test(i)),
      JSON.stringify(json.issues),
    ).toBe(true);
    expect(t.manager.repositories.strategies.count()).toBe(0);
  });

  it('the same checks apply to an edit', async () => {
    const s = await app();
    t = s.t;
    const created = (await s.c.postWithCsrf('/api/strategies', VALID)).json() as StrategyJson;
    const definition = DEFINITION;
    const res = await s.c.postWithCsrf(`/api/strategies/${created.id}`, {
      ...definition,
      sizing: { ...definition.sizing, percent: 150 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues[0]).toMatch(/^sizing\.percent: /);
    expect(t.manager.repositories.strategyVersions.count()).toBe(1);
  });
});

describe('strategy API', () => {
  it('create → kill_switch=1, mode dry_run, current_version=1, one version row', async () => {
    const s = await app();
    t = s.t;
    const res = await s.c.postWithCsrf('/api/strategies', VALID);
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json() as StrategyJson;
    expect(created).toMatchObject({
      killSwitch: true,
      mode: 'dry_run',
      effectiveMode: 'paused',
      currentVersion: 1,
    });
    const repos = t.manager.repositories;
    expect(repos.strategies.get({ id: created.id })).toMatchObject({
      kill_switch: 1,
      mode: 'dry_run',
      current_version: 1,
      deleted_at: null,
    });
    expect(repos.strategyVersions.listForStrategy(created.id)).toHaveLength(1);
    expect(auditRows(t, 'strategy_created')).toHaveLength(1);
    // Defaults filled in (a minimal body).
    const minimal = (
      await s.c.postWithCsrf('/api/strategies', {
        name: 'NHL',
        sport: 'hockey',
        leagueIds: ['nhl'],
        rule: { type: 'lead_at_time', minLead: 2, atMinute: 50 },
        sizing: { percent: 1, minStakeUsd: 1, maxStakeUsd: 10 },
        execution: { maxPrice: 0.95 },
      })
    ).json() as StrategyJson & { execution: Record<string, unknown> };
    expect(minimal.rule).toMatchObject({ windowMinutes: 3, leaderSide: 'any', version: 1 });
    expect(minimal.execution).toEqual({
      orderType: 'ioc_limit',
      maxPrice: 0.95,
      minPrice: null,
      maxSlippage: 0.01,
      minDepthContracts: 20,
      maxFeedAgeSec: 15,
    });
  });

  it('edit minLead → version 2, version 1 unchanged; a trades row on version 1 still joins to its rule; toggles create no version', async () => {
    const s = await app();
    t = s.t;
    const repos = t.manager.repositories;
    const created = (await s.c.postWithCsrf('/api/strategies', VALID)).json() as StrategyJson;
    const v1 = repos.strategyVersions.get({ strategy_id: created.id, version: 1 });

    repos.games.insert({
      id: 'KXEPLGAME-26OCT17ARSCHE',
      league_id: 'epl',
      scheduled_at: '2026-10-17T14:00:00Z',
      updated_at: '2026-10-17T14:00:00Z',
    });
    repos.trades.insert({
      id: 'trade-v1',
      strategy_id: created.id,
      strategy_version: 1,
      game_id: 'KXEPLGAME-26OCT17ARSCHE',
      league_id: 'epl',
      kalshi_env: 'demo',
      configured_mode: 'dry_run',
      effective_mode: 'dry_run',
      mode_reason: 'addon_lock',
      status: 'signalled',
      trigger_snapshot: '{}',
      triggered_at: new Date().toISOString(),
      window_ends_at: new Date().toISOString(),
    });

    const definition = DEFINITION;
    const edit = await s.c.postWithCsrf(`/api/strategies/${created.id}`, {
      ...definition,
      rule: { ...definition.rule, minLead: 3 },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const edited = edit.json() as StrategyJson;
    expect(edited.currentVersion).toBe(2);
    expect(edited.rule.minLead).toBe(3);
    expect(edited.versions?.map((v) => [v.version, v.rule.minLead])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(repos.strategyVersions.get({ strategy_id: created.id, version: 1 })).toEqual(v1);
    expect(repos.strategies.get({ id: created.id })?.current_version).toBe(2);

    const joined = t.manager.current?.sqlite
      .prepare(
        `SELECT t.id, v.version, json_extract(v.rule, '$.minLead') AS minLead
           FROM trades t JOIN strategy_versions v
             ON v.strategy_id = t.strategy_id AND v.version = t.strategy_version`,
      )
      .all();
    expect(joined).toEqual([{ id: 'trade-v1', version: 1, minLead: 2 }]);

    // The same definition again, the kill switch and the mode: no new version.
    expect(
      (
        await s.c.postWithCsrf(`/api/strategies/${created.id}`, {
          ...definition,
          rule: { ...definition.rule, minLead: 3 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await s.c.postWithCsrf(`/api/strategies/${created.id}/kill-switch`, { killSwitch: false })).statusCode,
    ).toBe(200);
    expect((await s.c.postWithCsrf(`/api/strategies/${created.id}/mode`, { mode: 'live' })).statusCode).toBe(
      200,
    );
    expect(
      (await s.c.postWithCsrf(`/api/strategies/${created.id}/kill-switch`, { killSwitch: true })).statusCode,
    ).toBe(200);
    expect(repos.strategyVersions.listForStrategy(created.id)).toHaveLength(2);
    expect(repos.strategies.get({ id: created.id })?.current_version).toBe(2);
    // A rename alone changes the row, not the versions.
    const renamed = (
      await s.c.postWithCsrf(`/api/strategies/${created.id}`, {
        ...definition,
        name: 'Renamed',
        rule: { ...definition.rule, minLead: 3 },
      })
    ).json() as StrategyJson;
    expect([renamed.name, renamed.currentVersion]).toEqual(['Renamed', 2]);
    expect(repos.strategyVersions.listForStrategy(created.id)).toHaveLength(2);
    // The sport cannot change.
    const sport = await s.c.postWithCsrf(`/api/strategies/${created.id}`, {
      ...definition,
      sport: 'hockey',
      leagueIds: ['nhl'],
      rule: { ...definition.rule, atMinute: 50 },
    });
    expect(sport.statusCode).toBe(400);
  });

  it('delete → hidden by default, visible with ?includeDeleted=1', async () => {
    const s = await app();
    t = s.t;
    const a = (await s.c.postWithCsrf('/api/strategies', VALID)).json() as StrategyJson;
    const b = (await s.c.postWithCsrf('/api/strategies', { ...VALID, name: 'Other' })).json() as StrategyJson;
    expect(((await s.c.get('/api/strategies')).json() as StrategyJson[]).map((x) => x.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect((await s.c.postWithCsrf(`/api/strategies/${a.id}/delete`)).statusCode).toBe(200);
    expect(((await s.c.get('/api/strategies')).json() as StrategyJson[]).map((x) => x.id)).toEqual([b.id]);
    const all = (await s.c.get('/api/strategies?includeDeleted=1')).json() as StrategyJson[];
    expect(all.map((x) => [x.id, x.deletedAt !== null])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);
    expect(t.manager.repositories.strategies.get({ id: a.id })?.deleted_at).not.toBeNull();
    // A deleted strategy can no longer be changed.
    expect(
      (await s.c.postWithCsrf(`/api/strategies/${a.id}/kill-switch`, { killSwitch: false })).statusCode,
    ).toBe(404);
    expect(auditRows(t, 'strategy_deleted')).toHaveLength(1);
  });

  it('needs a session and a CSRF token', async () => {
    const s = await app();
    t = s.t;
    expect((await new Client(t.app, ingress()).get('/api/strategies')).statusCode).toBe(401);
    expect((await s.c.post('/api/strategies', VALID)).statusCode).toBe(403);
  });
});

describe('step-up', () => {
  it('kill switch off or mode → live without recent re-auth → 403 reauth_required; with it → 200 and an audit row; kill switch on and mode → dry run need none', async () => {
    const s = await app({ allowLiveOrders: false });
    t = s.t;
    const created = (await s.c.postWithCsrf('/api/strategies', VALID)).json() as StrategyJson;
    const repos = t.manager.repositories;
    ageAuth(t);

    const off = await s.c.postWithCsrf(`/api/strategies/${created.id}/kill-switch`, { killSwitch: false });
    expect([off.statusCode, off.json()]).toEqual([403, { error: 'reauth_required' }]);
    const live = await s.c.postWithCsrf(`/api/strategies/${created.id}/mode`, { mode: 'live' });
    expect([live.statusCode, live.json()]).toEqual([403, { error: 'reauth_required' }]);
    expect(repos.strategies.get({ id: created.id })).toMatchObject({ kill_switch: 1, mode: 'dry_run' });
    expect(auditRows(t, 'strategy_kill_switch_changed')).toHaveLength(0);
    expect(auditRows(t, 'strategy_mode_changed')).toHaveLength(0);

    expect((await s.c.postWithCsrf('/auth/reauth', { password: PASSWORD })).statusCode).toBe(200);
    const off2 = await s.c.postWithCsrf(`/api/strategies/${created.id}/kill-switch`, { killSwitch: false });
    expect(off2.statusCode).toBe(200);
    expect(off2.json()).toMatchObject({
      killSwitch: false,
      effectiveMode: 'dry_run',
      modeReason: 'addon_lock',
    });
    const live2 = await s.c.postWithCsrf(`/api/strategies/${created.id}/mode`, { mode: 'live' });
    expect(live2.statusCode).toBe(200);
    expect(live2.json()).toMatchObject({ mode: 'live', effectiveMode: 'dry_run', modeReason: 'addon_lock' });
    const [ks] = auditRows(t, 'strategy_kill_switch_changed');
    expect(ks).toMatchObject({
      entity: 'strategy',
      entity_id: created.id,
      mode: 'dry_run',
      actor: `user:${USER}`,
    });
    expect(JSON.parse(ks?.detail ?? '{}')).toEqual({ from: true, to: false });
    const [md] = auditRows(t, 'strategy_mode_changed');
    expect(md).toMatchObject({ entity_id: created.id, mode: 'dry_run' });
    expect(JSON.parse(md?.detail ?? '{}')).toEqual({ from: 'dry_run', to: 'live' });

    // Towards safety: no re-auth.
    ageAuth(t);
    const on = await s.c.postWithCsrf(`/api/strategies/${created.id}/kill-switch`, { killSwitch: true });
    expect(on.statusCode).toBe(200);
    const dry = await s.c.postWithCsrf(`/api/strategies/${created.id}/mode`, { mode: 'dry_run' });
    expect(dry.statusCode).toBe(200);
    expect(repos.strategies.get({ id: created.id })).toMatchObject({ kill_switch: 1, mode: 'dry_run' });
    expect(auditRows(t, 'strategy_kill_switch_changed')).toHaveLength(2);
    expect(auditRows(t, 'strategy_mode_changed')).toHaveLength(2);
  });

  it('with the add-on lock open and global dry run off, a live strategy is effectively live', async () => {
    const s = await app({ allowLiveOrders: true });
    t = s.t;
    t.manager.repositories.settings.set('global_dry_run', false);
    const created = (await s.c.postWithCsrf('/api/strategies', VALID)).json() as StrategyJson;
    await s.c.postWithCsrf(`/api/strategies/${created.id}/kill-switch`, { killSwitch: false });
    const res = (await s.c.postWithCsrf(`/api/strategies/${created.id}/mode`, { mode: 'live' })).json();
    expect(res).toMatchObject({ effectiveMode: 'live', modeReason: null });
    expect(auditRows(t, 'strategy_mode_changed')[0]?.mode).toBe('live');
  });
});
