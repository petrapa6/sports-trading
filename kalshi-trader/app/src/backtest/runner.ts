import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { Repositories } from '../db/repositories.js';
import type { ResolvedRequest } from './data.js';
import type { WorkerInput, WorkerMessage } from './worker.js';

/**
 * Starts backtests in `worker_threads` workers (SPEC.md §9 Performance, T12) and relays their progress (SSE
 * `backtest` events on `/api/live`). The `backtests` row is inserted before the worker starts
 * (`result_summary` `NULL` while running); the worker writes the trades and the summary itself.
 */

export type RunStatus = 'running' | 'done' | 'failed';

export interface BacktestProgress {
  id: string;
  status: RunStatus;
  done: number;
  total: number;
  error?: string;
}

export interface RunnerOptions {
  repos: () => Repositories;
  /** Absolute path of the database file the worker opens. */
  dbPath: () => string;
  log: RunnerLog;
  now?: () => number;
  /** Runs at the same time (more → `busy`). */
  maxConcurrent?: number;
  /** Unsaved finished runs kept (older ones are deleted when a new run starts). */
  keepUnsaved?: number;
}

/** The two log methods the runner uses (a Pino or Fastify logger). */
export interface RunnerLog {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export class BacktestBusyError extends Error {
  override name = 'BacktestBusyError';
}

const TS_SOURCE = import.meta.url.endsWith('.ts');

/** The worker entry: the compiled `worker.js`, or `worker.ts` through the tsx bootstrap in development. */
function spawnWorker(input: WorkerInput): Worker {
  const entry = new URL(TS_SOURCE ? './worker.ts' : './worker.js', import.meta.url);
  if (!TS_SOURCE) return new Worker(entry, { workerData: input });
  return new Worker(new URL('./tsxWorker.mjs', import.meta.url), {
    workerData: { ...input, entry: entry.href },
  });
}

export class BacktestRunner extends EventEmitter<{ progress: [BacktestProgress] }> {
  private readonly jobs = new Map<
    string,
    { progress: BacktestProgress; worker: Worker; finished: Promise<void> }
  >();
  private readonly log: RunnerLog;
  private readonly now: () => number;

  constructor(private readonly options: RunnerOptions) {
    super();
    this.setMaxListeners(0);
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
  }

  /** Progress of a run started by this process (`undefined` once forgotten or never started here). */
  progress(id: string): BacktestProgress | undefined {
    return this.jobs.get(id)?.progress;
  }

  running(): number {
    return [...this.jobs.values()].filter((j) => j.progress.status === 'running').length;
  }

  /** Resolves when the run has finished (tests). */
  async wait(id: string): Promise<BacktestProgress | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    await job.finished;
    return job.progress;
  }

  /** Inserts the `backtests` row and starts the worker; returns the new id. */
  start(request: ResolvedRequest): string {
    if (this.running() >= (this.options.maxConcurrent ?? 2)) {
      throw new BacktestBusyError('too many backtests are running');
    }
    const repos = this.options.repos();
    const id = randomUUID();
    repos.backtests.insert({
      id,
      created_at: new Date(this.now()).toISOString(),
      league_id: request.leagueIds.join(','),
      season: request.sinceIso
        ? `since ${request.sinceIso.slice(0, 10)}`
        : request.seasons.length > 0
          ? request.seasons.join(',')
          : 'all',
      strategy_version_ref: request.strategy ? `${request.strategy.id}@${request.strategy.version}` : null,
      params: JSON.stringify(request),
      price_mode: request.priceMode,
      initial_bankroll_micros: request.initialBankrollMicros,
      result_summary: null,
    });
    this.prune(id);

    const progress: BacktestProgress = { id, status: 'running', done: 0, total: 0 };
    const worker = spawnWorker({ dbPath: this.options.dbPath(), backtestId: id, request });
    const fields = {
      component: 'backtest',
      category: 'backtest',
      backtestId: id,
      priceMode: request.priceMode,
    };
    this.log.info(
      fields,
      `Backtest ${id} started: ${request.definition.name} over ${request.leagueIds.join(', ')} (${request.priceMode})`,
    );
    const finished = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (status: RunStatus, error?: string) => {
        if (settled) return;
        settled = true;
        progress.status = status;
        if (error !== undefined) progress.error = error;
        this.emit('progress', { ...progress });
        resolve();
      };
      worker.on('message', (m: WorkerMessage) => {
        if (m.type === 'progress') {
          progress.done = m.done;
          progress.total = m.total;
          this.emit('progress', { ...progress });
        } else if (m.type === 'done') {
          this.log.info(
            { ...fields, trades: m.trades, games: m.games },
            `Backtest ${id} finished: ${m.trades} trades over ${m.games} games`,
          );
          finish('done');
        } else {
          this.log.error({ ...fields, err: { message: m.message } }, `Backtest ${id} failed`);
          finish('failed', m.message);
        }
      });
      worker.on('error', (err) => {
        this.log.error({ ...fields, err: { message: err.message } }, `Backtest ${id} worker crashed`);
        this.markFailed(id, err.message);
        finish('failed', err.message);
      });
      worker.on('exit', (code) => {
        if (!settled) {
          const message =
            code === 0 ? 'the worker exited without a result' : `the worker stopped (exit ${code})`;
          this.markFailed(id, message);
          finish('failed', message);
        }
      });
    });
    this.jobs.set(id, { progress, worker, finished });
    return id;
  }

  /** Stops a running worker (the run is deleted by the caller). */
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.progress.status === 'running') await job.worker.terminate();
    this.jobs.delete(id);
  }

  /** Terminates every running worker (shutdown). */
  async close(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.worker.terminate()));
  }

  private markFailed(id: string, message: string): void {
    try {
      const repos = this.options.repos();
      const row = repos.backtests.get({ id });
      if (row && row.result_summary === null) {
        repos.backtests.update({ id }, { result_summary: JSON.stringify({ error: message.slice(0, 300) }) });
      }
    } catch {
      // database unavailable: the run shows as interrupted
    }
  }

  /** Deletes unsaved finished runs beyond the newest `keepUnsaved` (never `keepId`, never running ones). */
  private prune(keepId: string): void {
    const repos = this.options.repos();
    const keep = this.options.keepUnsaved ?? 10;
    const unsaved = repos.backtests
      .list()
      .filter(
        (b) => b.id !== keepId && b.result_summary !== null && !this.jobs.has(b.id) && !isSaved(b.params),
      )
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    for (const b of unsaved.slice(keep)) deleteBacktest(repos, b.id);
  }
}

/** Whether a stored `params` JSON marks the run as saved. */
export function isSaved(params: string | null): boolean {
  try {
    return (JSON.parse(params ?? '{}') as { saved?: unknown }).saved === true;
  } catch {
    return false;
  }
}

/** Deletes a run and its trades. */
export function deleteBacktest(repos: Repositories, id: string): boolean {
  repos.backtestTrades.deleteByBacktest(id);
  return repos.backtests.delete({ id });
}
