/// <reference lib="dom" />
import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { ensureUser, expectNoHorizontalScroll, login, watchConsole } from './helpers.js';

let cspProblems: string[] = [];
test.beforeEach(({ context }) => {
  cspProblems = watchConsole(context);
});
test.afterEach(() => {
  expect(cspProblems, 'console messages about the Content Security Policy').toEqual([]);
});

const GAME = 'KXNHLGAME-26OCT14SEAVGK';
const SERVER = `http://127.0.0.1:${Number(process.env['E2E_PORT'] ?? 8198)}`;

interface Frame {
  games: {
    id: string;
    homeScore: number | null;
    awayScore: number | null;
    phase: string;
    clock: Record<string, unknown>;
  }[];
}

test('replay at 100×: the card appears, its score changes and it reaches "Final" within 30 s; SSE carries games[]', async ({
  page,
}) => {
  await ensureUser(page);
  await login(page);
  await expect(page.getByRole('heading', { level: 2, name: 'Live games' })).toBeVisible();

  // A second stream in the page records every `games` frame.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: unknown[] };
    w.__frames = [];
    const es = new EventSource(new URL('api/live', document.baseURI));
    es.addEventListener('games', (e) => w.__frames.push(JSON.parse((e as MessageEvent<string>).data)));
  });

  const started = Date.now();
  const replay = spawn(
    'npx',
    [
      'tsx',
      'scripts/replay.ts',
      '--file',
      'test/fixtures/replay/nhl-sample.jsonl',
      '--speed',
      '100',
      '--url',
      SERVER,
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  replay.stdout.on('data', (d: Buffer) => (output += d.toString()));
  replay.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const exited = new Promise<number | null>((r) => replay.on('exit', r));

  const card = page.getByTestId(`game-card-${GAME}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('away-score')).toHaveText('1', { timeout: 30_000 });
  await expect(card.getByTestId('game-phase')).toHaveText('Final', { timeout: 30_000 });
  await expect(card.getByTestId('home-score')).toHaveText('2');
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(await exited, output).toBe(0);

  const frames = (await page.evaluate(
    () => (window as unknown as { __frames: unknown[] }).__frames,
  )) as Frame[];
  const states = frames.flatMap((f) => f.games.filter((g) => g.id === GAME));
  expect(states.length).toBeGreaterThan(3);
  const live = states.find((g) => g.phase === 'live' && g.awayScore === 1);
  expect(live).toMatchObject({ homeScore: 1, awayScore: 1, clock: { minute: 27, minuteSource: 'feed' } });
  expect(states.every((g) => 'homeScore' in g && 'awayScore' in g && 'regulationOver' in g.clock)).toBe(true);
  expect(states.at(-1)).toMatchObject({ phase: 'finished', homeScore: 2, awayScore: 1 });
  await expectNoHorizontalScroll(page);
});
