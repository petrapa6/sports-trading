/**
 * Drill (d) `kill-switch`: the global kill switch on with a live game, a live strategy and the add-on lock open → zero
 * outgoing requests over 10 minutes of fake time (msw + the feed stand-ins) and `/healthz` 200 `paused`.
 *
 * Fake time and the msw stand-ins need Vitest, so the drill itself is `test/drills/kill-switch.test.ts` (also part of
 * `npm test`); this script runs it and prints what it observed.
 *
 *   npx tsx scripts/drills/kill-switch.ts
 */
import { runVitestDrill } from './lib.js';

runVitestDrill('kill-switch');
