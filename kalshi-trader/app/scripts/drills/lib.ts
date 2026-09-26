/**
 * Shared helpers for the failure drills (SPEC.md §14 T14, `scripts/drills/`): a scratch instance of the app
 * (`tsx src/server/main.ts` with `NODE_ENV=development`, its own database and data directory under
 * `.local/drills/<name>/`, no Kalshi credentials, no config.local.json), a signed-in HTTP client for it, and
 * step / result printing. The drill endpoints exist only in that development mode (`/api/dev/drills/*`).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { APP, cleanEnv, sleep } from '../verify-lib.js';

export const USER = 'drill';
export const PASSWORD = 'drill password, long enough';

export interface Instance {
  name: string;
  dir: string;
  dbPath: string;
  base: string;
  child: ChildProcess;
  /** Server stdout (Pino JSON lines) so far. */
  logs: () => string;
  stop: () => Promise<void>;
}

/** Starts a scratch development instance on `port` and waits until `/healthz` answers. */
export async function startInstance(
  name: string,
  port: number,
  extraEnv: Record<string, string> = {},
): Promise<Instance> {
  const dir = join(APP, '.local/drills', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'trader.db');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    cwd: APP,
    env: cleanEnv({
      NODE_ENV: 'development',
      PORT: String(port),
      DB_PATH: dbPath,
      DATA_DIR: join(dir, 'data'),
      LOG_LEVEL: 'info',
      TZ: 'UTC',
      ...extraEnv,
    }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  const base = `http://127.0.0.1:${port}`;
  const instance: Instance = {
    name,
    dir,
    dbPath,
    base,
    child,
    logs: () => out,
    stop: async () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      await Promise.race([exited, sleep(5000)]);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    },
  };
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`the instance exited (${child.exitCode}):\n${out.slice(-2000)}`);
    try {
      await fetch(`${base}/healthz`);
      return instance;
    } catch {
      if (Date.now() - started > 60_000) {
        await instance.stop();
        throw new Error(`no answer on ${base}/healthz within 60 s:\n${out.slice(-2000)}`);
      }
      await sleep(200);
    }
  }
}

export interface HttpResult {
  status: number;
  body: string;
  ms: number;
}

/** A cookie-keeping HTTP client for a drill instance (loopback, so class `dev`). */
export class DrillClient {
  private cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size > 0) h['cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    const started = Date.now();
    const res = await fetch(this.base + path, {
      method,
      headers: h,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, body: await res.text(), ms: Date.now() - started } satisfies HttpResult;
  }

  get(path: string) {
    return this.request('GET', path);
  }

  async postWithCsrf(path: string, body: unknown) {
    const csrf = await this.get('/api/csrf');
    const token = (JSON.parse(csrf.body) as { token: string }).token;
    return this.request('POST', path, body, { 'x-csrf-token': token });
  }

  /** First-run setup (allowed for class `dev`), which also signs in. */
  async setup(): Promise<void> {
    const r = await this.request('POST', '/setup', { username: USER, password: PASSWORD });
    if (r.status !== 201) throw new Error(`setup → ${r.status} ${r.body}`);
  }
}

let failed = false;

/** Prints one drill step: `ok` or `FAIL`, the description and the observation. */
export function step(ok: boolean, what: string, observed: string): void {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what} — ${observed}`);
}

/** Prints the verdict and exits (non-zero if any step failed). */
export function done(name: string): never {
  console.log(failed ? `DRILL ${name}: FAILED` : `DRILL ${name}: PASSED`);
  process.exit(failed ? 1 : 0);
}

/** Pino JSON lines of a log text (non-JSON lines skipped). */
export function logLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // not a log line
    }
  }
  return out;
}

export { sleep };

/** Runs `test/drills/<name>.test.ts` (fake time + msw need Vitest), prints its observations and the verdict. */
export function runVitestDrill(name: string): never {
  const r = spawnSync('npx', ['vitest', 'run', `test/drills/${name}.test.ts`, '--silent=false'], {
    cwd: APP,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  const passed = r.status === 0 && /Tests\s+1 passed/.test(out);
  const observed = out
    .split('\n')
    .filter((l) => /^(outage|attempts|recovery|kill switch on|control)\b/.test(l.trim()))
    .map((l) => l.trim());
  for (const line of observed) console.log(`${passed ? 'ok  ' : 'FAIL'} ${line}`);
  if (!passed) console.log(out.slice(-3000));
  console.log(passed ? `DRILL ${name}: PASSED` : `DRILL ${name}: FAILED`);
  process.exit(passed ? 0 : 1);
}
