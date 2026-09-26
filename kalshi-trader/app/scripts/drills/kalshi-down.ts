/**
 * Drill (c) `kalshi-down`: Kalshi answers 503 to everything for 10 minutes of fake time while an NHL game is live and a
 * dry-run strategy's window is open → the feeds keep being polled, every entry attempt ends `error` (trade
 * `waiting`), and the first successful Kalshi call afterwards is logged ("Kalshi reachable again").
 *
 * Fake time and the msw stand-ins need Vitest, so the drill itself is `test/drills/kalshi-down.test.ts` (also part of
 * `npm test`); this script runs it and prints what it observed.
 *
 *   npx tsx scripts/drills/kalshi-down.ts
 */
import { runVitestDrill } from './lib.js';

runVitestDrill('kalshi-down');
