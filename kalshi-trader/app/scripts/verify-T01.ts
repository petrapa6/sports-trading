/**
 * `npm run verify:T01` — runs the automatable T01 acceptance checks (SPEC.md §14) and
 * prints PASS / FAIL / MANUAL per item. Manual items are documented in
 * docs/verification/T01.md.
 *
 *   --quick   skip the fresh-clone `npm ci && lint && typecheck && test && e2e` run
 *             (runs lint/typecheck/test/e2e in place instead)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const APP = resolve(import.meta.dirname, '..');
const ROOT = resolve(APP, '../..');
const quick = process.argv.includes('--quick');

type Outcome = 'PASS' | 'FAIL' | 'MANUAL';
const results: { item: string; outcome: Outcome; detail: string }[] = [];

function record(item: string, outcome: Outcome, detail = ''): void {
  results.push({ item, outcome, detail });
  console.log(`${outcome.padEnd(6)} ${item}${detail ? ` — ${detail}` : ''}`);
}

async function check(
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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? APP,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Environment for `npm run dev` without anything inherited that would change the config. */
function devEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const drop = new Set([
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
  ]);
  for (const [k, v] of Object.entries(process.env)) if (!drop.has(k)) env[k] = v;
  return { ...env, ...extra };
}

interface Dev {
  child: ChildProcess;
  stdout: () => string;
  exited: Promise<number | null>;
  stop: () => Promise<void>;
}

/** Starts `npm run dev` in its own process group so the whole tree can be stopped. */
function startDev(env: NodeJS.ProcessEnv): Dev {
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
      // Always signal the whole process group: npm may already be gone while tsx still runs.
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

async function waitForHealth(port: number, timeoutMs: number): Promise<{ body: string; ms: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      return { body: await res.text(), ms: Date.now() - start };
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`no answer on :${port}/healthz within ${timeoutMs} ms`);
}

function jsonLines(text: string): Record<string, unknown>[] {
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

// 1. Fresh clone: npm ci && lint && typecheck && test && e2e
await check('Fresh clone on Node 22: npm ci && lint && typecheck && test && e2e exit 0', () => {
  assert(process.versions.node.startsWith('22.'), `running on Node ${process.versions.node}, expected 22`);
  let cwd = APP;
  let cleanup = (): void => undefined;
  if (!quick) {
    const dir = mkdtempSync(join(tmpdir(), 'kst-fresh-'));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    const clone = run('git', ['clone', '--quiet', '--no-hardlinks', ROOT, dir], { cwd: ROOT });
    assert(clone.code === 0, `git clone failed: ${clone.out}`);
    cwd = join(dir, 'kalshi-trader/app');
  }
  try {
    const steps = quick ? ['lint', 'typecheck', 'test', 'e2e'] : ['ci', 'lint', 'typecheck', 'test', 'e2e'];
    for (const step of steps) {
      const r = step === 'ci' ? run('npm', ['ci'], { cwd }) : run('npm', ['run', step], { cwd });
      assert(r.code === 0, `npm ${step} exited ${r.code}: ${r.out.slice(-800)}`);
    }
    return quick ? 'in place (--quick)' : 'fresh clone of HEAD';
  } finally {
    cleanup();
  }
});

// 2. npm run dev → /healthz within 5 s, stdout JSON only
await check(
  'npm run dev: /healthz returns exactly {"ok":true} within 5 s; every stdout line is JSON',
  async () => {
    const dev = startDev(devEnv({ CONFIG_LOCAL_PATH: '/nonexistent/config.local.json' }));
    try {
      const { body, ms } = await waitForHealth(8099, 5000);
      // Since T07 the body also carries the loop state: {"ok":true,"loop":"starting"|"idle"|…}.
      assert(/^\{"ok":true(,"loop":"[a-z]+")?\}$/.test(body), `body was ${body}`);
      await sleep(300);
      await dev.stop();
      const lines = jsonLines(dev.stdout());
      assert(lines.length > 0, 'no stdout');
      return `answered after ${ms} ms, ${lines.length} JSON lines`;
    } finally {
      await dev.stop();
    }
  },
);

// 3. Invalid settings fail fast
for (const [key, value] of [
  ['PORT', 'abc'],
  ['LOG_LEVEL', 'nope'],
  ['ALLOW_LIVE_ORDERS', 'maybe'],
] as const) {
  await check(`${key}=${value} npm run dev exits non-zero within 2 s naming ${key}`, async () => {
    const start = Date.now();
    const dev = startDev(devEnv({ [key]: value, CONFIG_LOCAL_PATH: '/nonexistent/config.local.json' }));
    const code = await Promise.race([dev.exited, sleep(2000).then(() => 'timeout' as const)]);
    const ms = Date.now() - start;
    await dev.stop();
    assert(code !== 'timeout', 'still running after 2 s');
    assert(code !== 0, 'exited 0');
    assert(dev.stdout().includes(key), `output does not mention ${key}: ${dev.stdout()}`);
    return `exit ${code} after ${ms} ms`;
  });
}

// 4. No config → starts, exactly one warn about Kalshi credentials, allowLiveOrders false
await check(
  'No config.local.json / no Kalshi settings: starts, exactly one warn, ALLOW_LIVE_ORDERS=false',
  async () => {
    const dev = startDev(devEnv({ PORT: '8197', CONFIG_LOCAL_PATH: '/nonexistent/config.local.json' }));
    try {
      await waitForHealth(8197, 5000);
      await sleep(300);
    } finally {
      await dev.stop();
    }
    const lines = jsonLines(dev.stdout());
    const warns = lines.filter((l) => l['level'] === 40);
    assert(warns.length === 1, `expected 1 warn line, got ${warns.length}`);
    assert(
      /kalshi credentials/i.test(String(warns[0]?.['msg'])),
      `warn is not about credentials: ${warns[0]?.['msg']}`,
    );
    const start = lines.find((l) => 'allowLiveOrders' in l);
    assert(start?.['allowLiveOrders'] === false, 'startup line does not show allowLiveOrders=false');
    return 'one warn, allowLiveOrders=false';
  },
);

// 5. config.local.json port honoured, env overrides
await check('config.local.json {"port": 8123} is honoured; env PORT=8124 overrides it', async () => {
  const defaultPath = join(APP, 'config.local.json');
  let extra: Record<string, string> = {};
  let created = false;
  let tmp: string | undefined;
  if (existsSync(defaultPath)) {
    // Never touch a developer's real config.local.json; use an identical file elsewhere.
    tmp = mkdtempSync(join(tmpdir(), 'kst-cfg-'));
    writeFileSync(join(tmp, 'config.local.json'), '{"port": 8123}');
    extra = { CONFIG_LOCAL_PATH: join(tmp, 'config.local.json') };
  } else {
    writeFileSync(defaultPath, '{"port": 8123}');
    created = true;
  }
  try {
    let dev = startDev(devEnv(extra));
    try {
      const { body } = await waitForHealth(8123, 5000);
      assert(body === '{"ok":true}', `8123 answered ${body}`);
    } finally {
      await dev.stop();
    }
    dev = startDev(devEnv({ ...extra, PORT: '8124' }));
    try {
      const { body } = await waitForHealth(8124, 5000);
      assert(body === '{"ok":true}', `8124 answered ${body}`);
    } finally {
      await dev.stop();
    }
    return created ? 'using ./config.local.json (removed afterwards)' : 'using a temporary config.local.json';
  } finally {
    if (created) rmSync(defaultPath, { force: true });
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
});

// 6. Decimal tests
await check('Decimal tests: examples, precision errors, 1 000-value round trip', () => {
  const r = run('npx', ['vitest', 'run', 'test/unit/decimal.test.ts']);
  assert(r.code === 0, r.out.slice(-800));
  const m = /Tests\s+(\d+) passed/.exec(r.out);
  return m ? `${m[1]} tests passed` : 'passed';
});

// 7. Secret hook + ignores, on a scratch branch in a temporary worktree
await check(
  'Secret hook rejects a committed private-key header; config.local.json and foo.db are ignored',
  () => {
    const hook = join(ROOT, '.git/hooks/pre-commit');
    assert(existsSync(hook), 'pre-commit hook is not installed (run npm install in kalshi-trader/app)');
    const dir = mkdtempSync(join(tmpdir(), 'kst-hook-'));
    const branch = `verify-t01-scratch-${Date.now()}`;
    const wt = join(dir, 'wt');
    const add = run('git', ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], { cwd: ROOT });
    assert(add.code === 0, `git worktree add failed: ${add.out}`);
    try {
      const header = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
      writeFileSync(join(wt, 'leak.txt'), `${header}\n`);
      run('git', ['add', 'leak.txt'], { cwd: wt });
      const commit = run(
        'git',
        ['-c', 'user.name=verify', '-c', 'user.email=verify@example.invalid', 'commit', '-m', 'leak'],
        {
          cwd: wt,
        },
      );
      assert(commit.code !== 0, 'commit containing a private-key header was accepted');

      run('git', ['reset', '-q'], { cwd: wt });
      rmSync(join(wt, 'leak.txt'));
      writeFileSync(join(wt, 'config.local.json'), '{}');
      writeFileSync(join(wt, 'foo.db'), '');
      const status = run('git', ['status', '--porcelain'], { cwd: wt });
      assert(!status.out.includes('config.local.json'), 'config.local.json shows in git status');
      assert(!status.out.includes('foo.db'), 'foo.db shows in git status');
      return 'commit rejected; git status clean';
    } finally {
      run('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT });
      run('git', ['branch', '-D', branch], { cwd: ROOT });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// 8. Conventions doc and SPEC.md
await check(
  'docs/decisions/0001-conventions.md covers slug, map, base image, DB path; SPEC.md at root',
  () => {
    assert(existsSync(join(ROOT, 'SPEC.md')), 'SPEC.md missing');
    const doc = readFileSync(join(ROOT, 'docs/decisions/0001-conventions.md'), 'utf8').toLowerCase();
    for (const topic of ['slug', 'map', 'base image', 'db path']) {
      assert(doc.includes(topic), `0001-conventions.md does not mention "${topic}"`);
    }
    assert(existsSync(join(ROOT, 'docs/verification/T01.md')), 'docs/verification/T01.md missing');
  },
);

// 9. CI
record('Branch pushed; GitHub Actions run green', 'MANUAL', 'see docs/verification/T01.md for the run URL');

const failed = results.filter((r) => r.outcome === 'FAIL').length;
console.log(
  `\n${results.length - failed} of ${results.length} items not failing${failed ? `, ${failed} FAILED` : ''}.`,
);
process.exit(failed ? 1 : 0);
