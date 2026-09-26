/**
 * `npm run fixtures:record:feeds -- [--minutes 240] [--interval 5] [--out <file.jsonl>]` (SPEC.md §14
 * T07) — records a real evening in the replay format (`src/core/replay.ts`): every `--interval`
 * seconds it reads the NHL Web API (`/v1/score/now`, every game in progress or just finished) and,
 * when a Kalshi key is configured, one batch of Kalshi live data for the games the local database
 * tracks. A line is written when a game's payload changed. Play it back with `npm run replay`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { destination, pino } from 'pino';
import { loadConfig, readPrivateKey } from '../src/config.js';
import { GameTracker } from '../src/core/tracker.js';
import { DatabaseManager } from '../src/db/database.js';
import { KalshiClient } from '../src/feeds/kalshi/client.js';
import { createNetworkGate } from '../src/feeds/network.js';
import { NhlFeed } from '../src/feeds/nhl/feed.js';
import type { ReplayLine } from '../src/core/replay.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const minutes = Number(arg('minutes', '240'));
const intervalSec = Number(arg('interval', '5'));
const day = new Date().toISOString().slice(0, 10);
const out = resolve(
  arg('out', resolve(import.meta.dirname, `../test/fixtures/replay/recorded-${day}.jsonl`)),
);
mkdirSync(dirname(out), { recursive: true });

const log = pino({ level: 'warn' }, destination(2));
const { config } = loadConfig();
const database = new DatabaseManager(config.dbPath, log);
database.open();
const gate = createNetworkGate(() => database.repositories.settings.get('global_kill_switch'));
const tracker = new GameTracker({ repos: () => database.repositories, log });
const nhl = new NhlFeed({ gate, log, games: () => [] });
const pem = readPrivateKey(config);
const kalshi =
  config.kalshiKeyId !== undefined && pem !== undefined
    ? new KalshiClient({
        env: config.kalshiEnv,
        keyId: config.kalshiKeyId,
        privateKey: pem,
        subaccount: config.kalshiSubaccount,
        gate,
        log,
      })
    : undefined;

const last = new Map<string, string>();
let written = 0;
function write(line: ReplayLine): void {
  const key = `${line.feed}:${line.game.id}`;
  const payload = JSON.stringify(line.payload);
  if (last.get(key) === payload) return;
  last.set(key, payload);
  appendFileSync(out, `${JSON.stringify(line)}\n`);
  written++;
}

const stopAt = Date.now() + minutes * 60_000;
console.log(
  `recording to ${out} for ${minutes} min every ${intervalSec} s (Kalshi: ${kalshi ? 'on' : 'no key'})`,
);
while (Date.now() < stopAt) {
  const at = new Date().toISOString();
  try {
    for (const g of await nhl.scoreNow()) {
      if (!['PRE', 'LIVE', 'CRIT', 'FINAL', 'OFF'].includes(g.gameState)) continue;
      write({
        at,
        feed: 'nhl-official',
        game: {
          id: `NHL-${g.id}`,
          leagueId: 'nhl',
          ...(g.startTimeUTC ? { scheduledAt: g.startTimeUTC } : {}),
          home: { name: g.homeTeam.abbrev, abbreviation: g.homeTeam.abbrev },
          away: { name: g.awayTeam.abbrev, abbreviation: g.awayTeam.abbrev },
        },
        payload: g as Record<string, unknown>,
      });
    }
  } catch (err) {
    console.error(`NHL: ${(err as Error).message}`);
  }
  if (kalshi) {
    try {
      const games = tracker.pollTargets().filter((g) => g.milestoneId);
      const byMilestone = new Map(games.map((g) => [g.milestoneId as string, g]));
      const records = byMilestone.size > 0 ? await kalshi.getLiveDataBatch([...byMilestone.keys()]) : [];
      for (const live of records) {
        const g = live.milestone_id ? byMilestone.get(live.milestone_id) : undefined;
        if (!g) continue;
        write({
          at,
          feed: 'kalshi-live',
          game: {
            id: g.id,
            leagueId: g.leagueId,
            scheduledAt: new Date(g.scheduledAt).toISOString(),
            ...(g.milestoneId ? { milestoneId: g.milestoneId } : {}),
            home: { name: g.home?.name ?? 'Home', abbreviation: g.home?.abbreviation ?? 'HOME' },
            away: { name: g.away?.name ?? 'Away', abbreviation: g.away?.abbreviation ?? 'AWAY' },
          },
          payload: live as Record<string, unknown>,
        });
      }
    } catch (err) {
      console.error(`Kalshi: ${(err as Error).message}`);
    }
  }
  await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
database.close();
console.log(`done: ${written} line(s) written to ${out}`);
