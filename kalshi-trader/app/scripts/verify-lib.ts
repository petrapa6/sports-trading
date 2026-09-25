/**
 * Helpers shared by the `verify:TXX` scripts: PASS / FAIL / MANUAL reporting, running commands,
 * and starting `npm run dev` in its own process group with a clean environment.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export const APP = resolve(import.meta.dirname, '..');
export const ROOT = resolve(APP, '../..');

type Outcome = 'PASS' | 'FAIL' | 'MANUAL';
const results: { item: string; outcome: Outcome; detail: string }[] = [];

export function record(item: string, outcome: Outcome, detail = ''): void {
  results.push({ item, outcome, detail });
  console.log(`${outcome.padEnd(6)} ${item}${detail ? ` — ${detail}` : ''}`);
}

export async function check(
  item: string,
  fn: () => Promise<string | undefined> | string | undefined,
): Promise<void> {
  try {
    const detail = await fn();
    record(item, 'PASS', detail ?? '');
  } catch (err) {
    record(item, 'FAIL', (err as Error).message);
  }
}

/** Prints the summary and exits non-zero if any item failed. */
export function finish(): never {
  const failed = results.filter((r) => r.outcome === 'FAIL').length;
  console.log(
    `\n${results.length - failed} of ${results.length} items not failing${failed ? `, ${failed} FAILED` : ''}.`,
  );
  process.exit(failed ? 1 : 0);
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? APP,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONFIG_VARS = [
  'KALSHI_ENV',
  'KALSHI_KEY_ID',
  'KALSHI_PRIVATE_KEY_FD',
  'KALSHI_SUBACCOUNT',
  'ALLOW_LIVE_ORDERS',
  'LOG_LEVEL',
  'DATA_DIR',
  'DB_PATH',
  'PORT',
  'TRUSTED_PROXIES',
  'TZ',
  'CONFIG_LOCAL_PATH',
];

/** The current environment minus every app setting, plus `extra`; no config.local.json is read. */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!CONFIG_VARS.includes(k)) env[k] = v;
  return { ...env, CONFIG_LOCAL_PATH: '/nonexistent/config.local.json', ...extra };
}

export interface Dev {
  child: ChildProcess;
  stdout: () => string;
  exited: Promise<number | null>;
  stop: () => Promise<void>;
}

/** Starts `npm run dev` in its own process group so the whole tree can be stopped. */
export function startDev(env: NodeJS.ProcessEnv): Dev {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: APP,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', () => undefined);
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return {
    child,
    stdout: () => out,
    exited,
    stop: async () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // already gone
      }
      await Promise.race([exited, sleep(3000)]);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
      await sleep(200);
    },
  };
}

/** Polls `/healthz` until the server answers (any status). */
export async function waitForHealth(
  port: number,
  timeoutMs: number,
): Promise<{ status: number; body: string; ms: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      return { status: res.status, body: await res.text(), ms: Date.now() - start };
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`no answer on :${port}/healthz within ${timeoutMs} ms`);
}

export function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        throw new Error(`stdout line ${i + 1} is not JSON: ${l.slice(0, 120)}`);
      }
    });
}

/** Runs one Vitest file (optionally filtered by test name) and returns "N tests passed". */
export function vitest(files: string[], name?: string): string {
  const args = ['vitest', 'run', ...files, ...(name ? ['-t', name] : [])];
  const r = run('npx', args);
  assert(r.code === 0, r.out.slice(-1500));
  const passed = /Tests\s+(\d+) passed/.exec(r.out);
  const skipped = /(\d+) skipped/.exec(r.out);
  return `${passed?.[1] ?? '?'} tests passed${skipped ? `, ${skipped[1]} skipped` : ''}`;
}
