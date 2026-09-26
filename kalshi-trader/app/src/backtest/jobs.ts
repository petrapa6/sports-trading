import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { NetworkPaused } from '../feeds/network.js';

/**
 * Long-running data jobs of Settings → Data (SPEC.md §14 T11): NHL season import, Kalshi backfill
 * (discovery + play-by-play) and the candle collector. Jobs live in memory only (a restart forgets
 * them; every job is resumable because it skips what is already stored).
 *
 * - **Global kill switch:** a job calls `ctx.request(fn)` for every outgoing request. While the switch
 *   is on the job is `paused` and makes zero requests; it resumes by itself when the switch is turned
 *   off (`wake()` is called on every switch change; the switch is also re-read every `pollMs`). A
 *   request rejected with `NetworkPaused` (the switch flipped in between) is retried after the pause.
 * - **Cancel** (`DELETE /api/jobs/:id`): aborts the job's `AbortSignal` (the request in flight is
 *   aborted) and the next `checkpoint()` throws `JobCancelled`. Rows already written stay.
 * - Every state or progress change is emitted as `job` (pushed over `/api/live`).
 */

export type JobType = 'nhl_import' | 'kalshi_backfill' | 'candles';
export type JobStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface JobView {
  id: string;
  type: JobType;
  label: string;
  status: JobStatus;
  done: number;
  total: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
}

export class JobCancelled extends Error {
  override name = 'JobCancelled';
  constructor() {
    super('the job was cancelled');
  }
}

/** A job of the same type is already running (`409 job_running`). */
export class JobRunning extends Error {
  override name = 'JobRunning';
  constructor(readonly job: JobView) {
    super(`a ${job.type} job is already running`);
  }
}

export interface JobContext {
  readonly signal: AbortSignal;
  readonly log: Logger;
  /** Throws `JobCancelled` once cancelled; waits (status `paused`) while the global kill switch is on. */
  checkpoint(): Promise<void>;
  /** One outgoing request: `checkpoint()` first; a `NetworkPaused` rejection pauses and retries. */
  request<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  progress(done: number, total?: number | null, message?: string | null): void;
}

export interface JobManagerOptions {
  /** Whether the global kill switch is on (read on every check; errors count as on: fail closed). */
  isPaused: () => boolean;
  log: Logger;
  now?: () => number;
  /** How often a paused job re-reads the switch (default 1 s). */
  pollMs?: number;
  /** Finished jobs kept for `GET /api/jobs` (default 20). */
  keep?: number;
}

interface Entry {
  view: JobView;
  abort: AbortController;
  promise: Promise<void>;
}

export class JobManager extends EventEmitter<{ job: [JobView] }> {
  private readonly jobs = new Map<string, Entry>();
  private readonly wakers = new Set<() => void>();
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly options: JobManagerOptions) {
    super();
    this.setMaxListeners(0);
    this.now = options.now ?? Date.now;
    this.log = options.log.child({ component: 'jobs' });
  }

  private paused(): boolean {
    try {
      return this.options.isPaused();
    } catch {
      return true;
    }
  }

  /** Called after a switch change: paused jobs re-check at once. */
  wake(): void {
    for (const w of [...this.wakers]) w();
  }

  list(): JobView[] {
    return [...this.jobs.values()].map((e) => ({ ...e.view })).reverse();
  }

  get(id: string): JobView | undefined {
    const e = this.jobs.get(id);
    return e ? { ...e.view } : undefined;
  }

  running(type: JobType): JobView | undefined {
    for (const e of this.jobs.values()) {
      if (e.view.type === type && (e.view.status === 'running' || e.view.status === 'paused'))
        return { ...e.view };
    }
    return undefined;
  }

  /** Resolves once the job has finished (tests, shutdown). */
  async wait(id: string): Promise<JobView | undefined> {
    await this.jobs.get(id)?.promise;
    return this.get(id);
  }

  /** Resolves once every job has finished. */
  async idle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((e) => e.promise));
  }

  /** Cancels a running or paused job; returns its view (`undefined` for an unknown id). */
  cancel(id: string): JobView | undefined {
    const e = this.jobs.get(id);
    if (!e) return undefined;
    if (e.view.status === 'running' || e.view.status === 'paused') {
      e.abort.abort(new JobCancelled());
      this.wake();
    }
    return { ...e.view };
  }

  /** Cancels everything (shutdown). */
  cancelAll(): void {
    for (const id of this.jobs.keys()) this.cancel(id);
  }

  /** Starts a job; throws `JobRunning` when a job of the same type is running or paused. */
  start(type: JobType, label: string, run: (ctx: JobContext) => Promise<unknown>): JobView {
    const busy = this.running(type);
    if (busy) throw new JobRunning(busy);
    const abort = new AbortController();
    const view: JobView = {
      id: randomUUID(),
      type,
      label,
      status: 'running',
      done: 0,
      total: null,
      message: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    };
    const log = this.log.child({ jobId: view.id, jobType: type });
    const emit = () => this.emit('job', { ...view });
    const setStatus = (status: JobStatus) => {
      if (view.status === status) return;
      view.status = status;
      emit();
    };

    const waitForResume = async (): Promise<void> => {
      if (!this.paused()) return;
      setStatus('paused');
      log.info({ job: label }, 'Job paused: the global kill switch is on');
      while (this.paused()) {
        if (abort.signal.aborted) throw new JobCancelled();
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.wakers.delete(done);
            abort.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, this.options.pollMs ?? 1000);
          this.wakers.add(done);
          abort.signal.addEventListener('abort', done);
        });
      }
      if (abort.signal.aborted) throw new JobCancelled();
      setStatus('running');
      log.info({ job: label }, 'Job resumed');
    };

    const ctx: JobContext = {
      signal: abort.signal,
      log,
      checkpoint: async () => {
        if (abort.signal.aborted) throw new JobCancelled();
        await waitForResume();
      },
      request: async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        for (;;) {
          await ctx.checkpoint();
          try {
            return await fn(abort.signal);
          } catch (err) {
            if (abort.signal.aborted) throw new JobCancelled();
            if (err instanceof NetworkPaused) continue;
            throw err;
          }
        }
      },
      progress: (done, total, message) => {
        view.done = done;
        if (total !== undefined) view.total = total;
        if (message !== undefined) view.message = message;
        emit();
      },
    };

    log.info({ job: label }, 'Job started');
    const promise = (async () => {
      try {
        view.result = (await run(ctx)) ?? null;
        view.status = 'done';
        log.info({ job: label, result: view.result }, 'Job finished');
      } catch (err) {
        if (err instanceof JobCancelled || abort.signal.aborted) {
          view.status = 'cancelled';
          log.info({ job: label, done: view.done }, 'Job cancelled');
        } else {
          view.status = 'failed';
          view.error = (err as Error).message;
          log.warn({ job: label, err: { name: (err as Error).name, message: view.error } }, 'Job failed');
        }
      } finally {
        view.finishedAt = new Date(this.now()).toISOString();
        emit();
        this.prune();
      }
    })();
    this.jobs.set(view.id, { view, abort, promise });
    emit();
    return { ...view };
  }

  private prune(): void {
    const keep = this.options.keep ?? 20;
    const finished = [...this.jobs.entries()].filter(
      ([, e]) => e.view.status !== 'running' && e.view.status !== 'paused',
    );
    for (const [id] of finished.slice(0, Math.max(0, finished.length - keep))) this.jobs.delete(id);
  }
}
