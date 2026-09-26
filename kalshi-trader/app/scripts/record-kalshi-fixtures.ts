/**
 * `npm run fixtures:record:kalshi` (SPEC.md §14 T06) — records raw responses of the Kalshi **demo**
 * environment into `test/fixtures/kalshi/recorded/`, so the hand-written fixtures the tests use can be
 * checked against real payloads (field names of milestones, live data and the batch live-data endpoint
 * in particular). Only public market-data endpoints are recorded: request headers (the credentials) are
 * never written, and no `/portfolio/*` response is stored. Without a demo key it prints
 * `SKIPPED (no demo key)` and exits 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { demoClient } from './kalshi-lib.js';

const OUT = resolve(import.meta.dirname, '../test/fixtures/kalshi/recorded');

const setup = demoClient();
if (!setup) process.exit(0);
const { client, database } = setup;
mkdirSync(OUT, { recursive: true });

let written = 0;
async function record(
  name: string,
  path: string,
  query: Record<string, string | number> = {},
): Promise<unknown> {
  try {
    const body = await client.getRaw(path, query);
    writeFileSync(resolve(OUT, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
    written++;
    console.log(`recorded ${name}`);
    return body;
  } catch (err) {
    console.log(`failed   ${name}: ${(err as Error).message}`);
    return undefined;
  }
}

try {
  await record('exchange_status', '/exchange/status');
  await record('exchange_schedule', '/exchange/schedule');
  await record('historical_cutoff', '/historical/cutoff');
  await record('series_sports', '/series', { category: 'Sports' });
  for (const league of database.repositories.leagues.listEnabled()) {
    const series = league.kalshi_series;
    await record(`series_${series}`, `/series/${series}`);
    const events = (await record(`events_${series}`, '/events', {
      series_ticker: series,
      status: 'open',
      with_nested_markets: 'true',
      limit: 5,
    })) as { events?: { event_ticker: string; markets?: { ticker: string }[] }[] } | undefined;
    const event = events?.events?.[0];
    if (!event) continue;
    await record(`event_${event.event_ticker}`, `/events/${event.event_ticker}`);
    const ms = (await record(`milestones_${event.event_ticker}`, '/milestones', {
      related_event_ticker: event.event_ticker,
    })) as { milestones?: { id: string }[] } | undefined;
    const market = event.markets?.[0]?.ticker;
    if (market) {
      await record(`market_${market}`, `/markets/${market}`);
      await record(`orderbook_${market}`, `/markets/${market}/orderbook`);
      const now = Math.floor(Date.now() / 1000);
      await record(`candlesticks_${market}`, `/series/${series}/markets/${market}/candlesticks`, {
        start_ts: now - 3600,
        end_ts: now,
        period_interval: 1,
      });
    }
    const milestone = ms?.milestones?.[0]?.id;
    if (milestone) {
      await record(`live_data_${milestone}`, `/live_data/milestone/${milestone}`);
      await record(`game_stats_${milestone}`, `/live_data/milestone/${milestone}/game_stats`);
      await record(`live_data_batch_${milestone}`, '/live_data/batch', { milestone_ids: milestone });
    }
  }
  console.log(`${written} responses written to ${OUT}`);
} finally {
  database.close();
}
