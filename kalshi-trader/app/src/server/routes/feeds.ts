import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type { Executor } from '../../core/executor.js';
import type { OrderGroupManager } from '../../core/orderGroup.js';
import type { Settler } from '../../core/settler.js';
import type { StrategyEngine } from '../../core/engine.js';
import { feedAvailable, type Scheduler } from '../../core/scheduler.js';
import type { GameTracker } from '../../core/tracker.js';
import type { DatabaseManager } from '../../db/database.js';
import { SETTINGS } from '../../db/settings.js';
import { quotaUsage } from '../../feeds/apiFootball/feed.js';
import {
  FEED_DEFAULT_ENABLED,
  FEED_IDS,
  FEED_NAMES,
  FeedQuotaExhausted,
  isFeedId,
  type FeedId,
  type ScoreFeed,
} from '../../feeds/gameState.js';
import { NetworkPaused } from '../../feeds/network.js';
import { userActor } from '../audit.js';
import { HttpError, parseBody } from '../http.js';
import type { LiveHub } from '../live.js';
import { encryptSetting } from '../secrets.js';
import { authOf, clientContext } from '../security.js';
import { describeKalshiError } from './kalshi.js';

/** The live pipeline; absent in tests that only exercise the HTTP layer. */
export interface LiveServices {
  tracker: GameTracker;
  scheduler: Scheduler;
  /** The adapters (the Kalshi one only with credentials; API-Football reports `isAvailable()`). */
  feeds: readonly ScoreFeed[];
  /** The strategy engine: its signals are pushed over `/api/live`. */
  engine?: StrategyEngine;
  /** Executor and settler: their trade changes are pushed over `/api/live`. */
  executor?: Pick<Executor, 'on'>;
  settler?: Pick<Settler, 'on'>;
  /** The Kalshi order group: Settings → Trading shows its status and resets it. */
  orderGroups?: Pick<OrderGroupManager, 'status' | 'reset'>;
}

const FeedPatch = z.object({ enabled: z.boolean() }).strict();

/** `POST /api/settings/api-football`: a new key (`null` removes it) and / or the daily request limit. */
const ApiFootballPatch = z
  .object({
    key: z
      .string()
      .trim()
      .min(8, 'the key is too short')
      .max(200, 'the key is too long')
      .regex(/^[\x21-\x7e]+$/, 'the key must not contain spaces or special characters')
      .nullable()
      .optional(),
    dailyLimit: SETTINGS.api_football_daily_limit.schema.optional(),
  })
  .strict();

export const FEED_SPORTS: Record<FeedId, string[]> = {
  'kalshi-live': ['soccer', 'hockey'],
  'nhl-official': ['hockey'],
  'api-football': ['soccer'],
};

/** Settings → Feeds: an adapter missing from the map has its default (API-Football off, the others on). */
export function isFeedEnabled(settings: Record<string, boolean>, id: FeedId): boolean {
  return settings[id] ?? FEED_DEFAULT_ENABLED[id];
}

const UNAVAILABLE: Record<FeedId, string> = {
  'kalshi-live':
    'Kalshi credentials are not configured: set the key id and the private key in the app configuration.',
  'nhl-official': 'The NHL adapter is not running.',
  'api-football': 'No API-Football key is stored: enter one below.',
};

/** The key field is shown masked: nothing of the key leaves the server. */
export const MASKED_KEY = '••••••••••••';

/**
 * Settings → Feeds and the dashboard's live data: tracked games, loop status, adapters on/off
 * (audited as `feed_change`; no step-up — a feed cannot lead to a real order by itself) and
 * "Test feed", which answers one line per adapter (always `200`).
 */
export function registerFeedRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  hub: LiveHub,
  live: LiveServices | undefined,
  secretKey: Buffer,
  now: () => number = Date.now,
): void {
  const auth = app.authService;

  app.get('/api/games', async () => ({ games: hub.games() }));

  app.get('/api/loop', async () => hub.loop());

  const feedList = () => {
    const enabled = database.repositories.settings.get('feeds');
    const status = hub.loop();
    return FEED_IDS.map((id) => {
      const s = status?.feeds.find((f) => f.id === id);
      const feed = live?.feeds.find((f) => f.id === id);
      const available = feed !== undefined && feedAvailable(feed);
      return {
        id,
        name: FEED_NAMES[id],
        sports: FEED_SPORTS[id],
        enabled: isFeedEnabled(enabled, id),
        available,
        status: s?.status ?? (available ? 'idle' : 'unavailable'),
        lastOkAt: s?.lastOkAt ?? null,
        lastError: s?.lastError ?? null,
      };
    });
  };

  app.get('/api/feeds', async () => feedList());

  app.post<{ Params: { id: string } }>('/api/feeds/:id', async (req) => {
    const { id } = req.params;
    if (!isFeedId(id)) throw new HttpError(404, 'not_found');
    const patch = parseBody(FeedPatch, req.body);
    const settings = database.repositories.settings;
    const current = settings.get('feeds');
    const from = isFeedEnabled(current, id);
    if (from !== patch.enabled) {
      settings.set('feeds', { ...current, [id]: patch.enabled });
      const { user } = authOf(req);
      auth.audit(
        { actor: userActor(user.username), ...clientContext(req) },
        {
          action: 'feed_change',
          entity: 'feed',
          entityId: id,
          detail: { enabled: { from, to: patch.enabled } },
        },
      );
      req.log.info(
        { feed: id, enabled: patch.enabled },
        `Feed ${id} ${patch.enabled ? 'enabled' : 'disabled'}`,
      );
      live?.scheduler.wake();
    }
    return feedList();
  });

  /** "Test feed": one result line per adapter. */
  app.post('/api/feeds/test', async () => {
    const enabled = database.repositories.settings.get('feeds');
    let games: ReturnType<GameTracker['pollTargets']> = [];
    try {
      games = live?.tracker.pollTargets() ?? [];
    } catch {
      games = [];
    }
    const results = await Promise.all(
      FEED_IDS.map(async (id) => {
        const base = { id, name: FEED_NAMES[id], enabled: isFeedEnabled(enabled, id) };
        const feed = live?.feeds.find((f) => f.id === id);
        if (!feed || !feedAvailable(feed)) return { ...base, ok: false, message: UNAVAILABLE[id] };
        try {
          const covered = games.filter((g) => feed.sports.includes(g.sport));
          return { ...base, ok: true, message: await feed.test(covered) };
        } catch (err) {
          if (err instanceof NetworkPaused)
            return {
              ...base,
              ok: false,
              message: 'The global kill switch is on, so the app makes no outgoing requests.',
            };
          if (err instanceof FeedQuotaExhausted)
            return { ...base, ok: false, message: `API-Football ${err.message}.` };
          const message =
            id === 'kalshi-live'
              ? describeKalshiError(err).message
              : err instanceof ZodError
                ? `The feed answered with an unexpected payload (${err.issues[0]?.path.join('.') || 'body'}).`
                : (err as Error).message || 'The request failed.';
          return { ...base, ok: false, message };
        }
      }),
    );
    return { results };
  });

  /** Settings → Feeds → API-Football: whether a key is stored (masked) and today's request usage. */
  const apiFootballView = () => {
    const settings = database.repositories.settings;
    return {
      configured: settings.get('api_football_key_enc') !== null,
      maskedKey: settings.get('api_football_key_enc') !== null ? MASKED_KEY : null,
      quota: quotaUsage(settings, now()),
    };
  };

  app.get('/api/settings/api-football', async () => apiFootballView());

  /**
   * Stores (encrypted with `encryptSetting`), replaces or removes the API-Football key and sets the daily
   * limit. Audited (`api_football_key_set` / `_removed`, `settings_change`); the key is never logged or
   * audited. No step-up: a score feed cannot lead to a real order by itself.
   */
  app.post('/api/settings/api-football', async (req) => {
    const patch = parseBody(ApiFootballPatch, req.body);
    const settings = database.repositories.settings;
    const actor = { actor: userActor(authOf(req).user.username), ...clientContext(req) };
    if (patch.key !== undefined) {
      const had = settings.get('api_football_key_enc') !== null;
      if (patch.key === null) {
        settings.set('api_football_key_enc', null);
        if (had) {
          auth.audit(actor, {
            action: 'api_football_key_removed',
            entity: 'settings',
            entityId: 'api_football_key_enc',
          });
          req.log.info('API-Football key removed');
        }
      } else {
        settings.set('api_football_key_enc', encryptSetting(patch.key, secretKey));
        auth.audit(actor, {
          action: 'api_football_key_set',
          entity: 'settings',
          entityId: 'api_football_key_enc',
          detail: { replaced: had },
        });
        req.log.info(had ? 'API-Football key replaced' : 'API-Football key stored');
      }
      live?.scheduler.wake();
    }
    if (patch.dailyLimit !== undefined) {
      const from = settings.get('api_football_daily_limit');
      if (from !== patch.dailyLimit) {
        settings.set('api_football_daily_limit', patch.dailyLimit);
        auth.audit(actor, {
          action: 'settings_change',
          entity: 'settings',
          detail: { api_football_daily_limit: { from, to: patch.dailyLimit } },
        });
      }
    }
    return apiFootballView();
  });
}
