import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type { StrategyEngine } from '../../core/engine.js';
import type { Scheduler } from '../../core/scheduler.js';
import type { GameTracker } from '../../core/tracker.js';
import type { DatabaseManager } from '../../db/database.js';
import { FEED_IDS, FEED_NAMES, isFeedId, type FeedId, type ScoreFeed } from '../../feeds/gameState.js';
import { NetworkPaused } from '../../feeds/network.js';
import { userActor } from '../audit.js';
import { HttpError, parseBody } from '../http.js';
import type { LiveHub } from '../live.js';
import { authOf, clientContext } from '../security.js';
import { describeKalshiError } from './kalshi.js';

/** The live pipeline (T07); absent in tests that only exercise the HTTP layer. */
export interface LiveServices {
  tracker: GameTracker;
  scheduler: Scheduler;
  /** The adapters that can run (the Kalshi one only with credentials). */
  feeds: readonly ScoreFeed[];
  /** The strategy engine (T08): its signals are pushed over `/api/live`. */
  engine?: StrategyEngine;
}

const FeedPatch = z.object({ enabled: z.boolean() }).strict();

export const FEED_SPORTS: Record<FeedId, string[]> = {
  'kalshi-live': ['soccer', 'hockey'],
  'nhl-official': ['hockey'],
};

export function isFeedEnabled(settings: Record<string, boolean>, id: FeedId): boolean {
  return settings[id] !== false;
}

const UNAVAILABLE: Record<FeedId, string> = {
  'kalshi-live':
    'Kalshi credentials are not configured: set the key id and the private key in the app configuration.',
  'nhl-official': 'The NHL adapter is not running.',
};

/**
 * Settings → Feeds and the dashboard's live data (T07): tracked games, loop status, adapters on/off
 * (audited as `feed_change`; no step-up — a feed cannot lead to a real order by itself) and
 * "Test feed", which answers one line per adapter (always `200`).
 */
export function registerFeedRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  hub: LiveHub,
  live: LiveServices | undefined,
): void {
  const auth = app.authService;

  app.get('/api/games', async () => ({ games: hub.games() }));

  app.get('/api/loop', async () => hub.loop());

  const feedList = () => {
    const enabled = database.repositories.settings.get('feeds');
    const status = hub.loop();
    return FEED_IDS.map((id) => {
      const s = status?.feeds.find((f) => f.id === id);
      const available = live?.feeds.some((f) => f.id === id) ?? false;
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
        if (!feed) return { ...base, ok: false, message: UNAVAILABLE[id] };
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
}
