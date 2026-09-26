import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../db/connection.js';
import { loadSimInput, saveFailure, saveResult, type ResolvedRequest } from './data.js';
import { simulate } from './simulator.js';

/**
 * Backtest worker (SPEC.md §9 Performance, T12): runs in a `worker_threads` thread with its own database
 * connection, so loading thousands of games and candles and simulating them never blocks the trading loop
 * or the HTTP server. Messages to the parent: `progress {done, total}`, then `done {summary}` or
 * `error {message}`. The result is written by the worker in one transaction.
 */

export interface WorkerInput {
  dbPath: string;
  backtestId: string;
  request: ResolvedRequest;
}

export type WorkerMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; trades: number; games: number }
  | { type: 'error'; message: string };

const post = (m: WorkerMessage) => parentPort?.postMessage(m);
const input = workerData as WorkerInput;
const db = openDatabase(input.dbPath);
try {
  const sim = loadSimInput(db.sqlite, input.request);
  const total = sim.games.length;
  post({ type: 'progress', done: 0, total });
  const every = Math.max(1, Math.floor(total / 50));
  const result = simulate(sim, (done, t) => post({ type: 'progress', done, total: t }), every);
  saveResult(db.sqlite, input.backtestId, result);
  post({ type: 'done', trades: result.summary.trades, games: total });
} catch (err) {
  const message = (err as Error).message;
  try {
    saveFailure(db.sqlite, input.backtestId, message);
  } catch {
    // the parent records the failure too
  }
  post({ type: 'error', message });
} finally {
  db.close();
}
