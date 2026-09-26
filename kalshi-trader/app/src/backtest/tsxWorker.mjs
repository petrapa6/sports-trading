// Development / test bootstrap for TypeScript worker threads: registers the tsx loader in the worker, then
// imports the real entry (`workerData.entry`). Builds run `dist/backtest/worker.js` directly.
import { workerData } from 'node:worker_threads';

const { register } = await import('tsx/esm/api');
register();
await import(workerData.entry);
