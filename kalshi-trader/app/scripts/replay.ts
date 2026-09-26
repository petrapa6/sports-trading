/**
 * `npm run replay -- --file test/fixtures/replay/<name>.jsonl --speed 100 [--url http://127.0.0.1:8099]`
 * (SPEC.md §14 T07) — plays a recorded feed evening back into a running development server
 * (`npm run dev`): each line is posted to `POST /api/dev/replay` after the recorded gap divided by
 * `--speed`, so the tracker, the snapshots, the archive and the dashboard's live cards see it exactly
 * like live polling. The first line of every game resets that game and schedules it now.
 */
import { readFileSync } from 'node:fs';
import { parseReplayFile } from '../src/core/replay.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const file = arg('file');
if (!file) {
  console.error('usage: npm run replay -- --file <replay.jsonl> [--speed 100] [--url http://127.0.0.1:8099]');
  process.exit(2);
}
const speed = Number(arg('speed') ?? '1');
if (!Number.isFinite(speed) || speed <= 0) {
  console.error('--speed must be a positive number');
  process.exit(2);
}
const base = (arg('url') ?? `http://127.0.0.1:${process.env['PORT'] ?? '8099'}`).replace(/\/+$/, '');

const lines = parseReplayFile(readFileSync(file, 'utf8'));
const seen = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log(`replaying ${lines.length} line(s) from ${file} at ${speed}× into ${base}`);

let previousAt: number | undefined;
for (const [i, line] of lines.entries()) {
  const at = Date.parse(line.at);
  if (previousAt !== undefined) await sleep(Math.max(0, (at - previousAt) / speed));
  previousAt = at;
  const reset = !seen.has(line.game.id);
  seen.add(line.game.id);
  const res = await fetch(`${base}/api/dev/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ line, reset }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    state?: { phase: string; homeScore: number; awayScore: number; clock: { minute?: number } } | null;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    console.error(
      `line ${i + 1}: ${res.status} ${body.error ?? ''} ${body.message ?? ''}`.trim() +
        (res.status === 404 ? ' (is this a development server on loopback?)' : ''),
    );
    process.exit(1);
  }
  const s = body.state;
  console.log(
    `[${i + 1}/${lines.length}] ${line.game.id} ${line.feed}` +
      (s
        ? ` ${s.phase} ${s.homeScore}-${s.awayScore}${s.clock.minute !== undefined ? ` ${s.clock.minute}'` : ''}`
        : ' (ignored)'),
  );
}
console.log('replay done');
