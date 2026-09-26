/**
 * `npm run verify:T05` — runs the T05 acceptance checks (SPEC.md §14) and prints PASS / FAIL / MANUAL
 * per item. Needs Docker with Compose and `openssl`; the arm64 item needs QEMU (binfmt) and is run only
 * with `--arm64` (CI job `arm64` in `.github/workflows/image.yml` runs `-- --only=arm64`).
 *
 *   npm run verify:T05                       # items 1–5, 7–9 (amd64 image via docker compose)
 *   npm run verify:T05 -- --arm64            # also item 6
 *   npm run verify:T05 -- --only=arm64       # only item 6
 *
 * Everything runs in `<repo>/.local/verify-T05/` (removed first) under the Compose project
 * `kst-verify-t05` on host port 8199, never in your own `./.local/data`. The fixture Kalshi key is
 * generated there with `openssl` (keys are never committed), turned into `options.json` by
 * `npm run compose:options`, and handed to the app on fd 3 by `run.sh` exactly as on Home Assistant.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROOT, assert, check, finish, record, run, sleep, vitest } from './verify-lib.js';

const argv = process.argv.slice(2);
const only = argv
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',');
const want = (item: string) => (only ? only.includes(item) : item !== 'arm64' || argv.includes('--arm64'));

const ADDON = join(ROOT, 'kalshi-trader');
const BASE = join(ROOT, '.local/verify-T05');
const DATA = join(BASE, 'data');
const PROJECT = 'kst-verify-t05';
const HOST_PORT = 8199;
const IMAGE = 'kalshi-trader:local';
const SIZE_LIMIT = 350 * 1000 * 1000;

const composeEnv = (nodeEnv = 'production'): NodeJS.ProcessEnv => ({
  ...process.env,
  KST_DATA_DIR: DATA,
  KST_HOST_PORT: String(HOST_PORT),
  KST_NODE_ENV: nodeEnv,
});
const compose = (args: string[], nodeEnv?: string) =>
  run('docker', ['compose', '-f', join(ROOT, 'docker-compose.yml'), '-p', PROJECT, ...args], {
    cwd: ROOT,
    env: composeEnv(nodeEnv),
  });
/** `docker compose exec -T` in the app container (as root unless `user` is given). */
const exec = (cmd: string, user?: string) =>
  compose(['exec', '-T', ...(user ? ['-u', user] : []), 'kalshi-trader', 'sh', '-c', cmd]);
const sh = (cmd: string, cwd = ROOT) => run('bash', ['-o', 'pipefail', '-c', cmd], { cwd });

/** Removes a directory the container may have filled with uid-1000 files (mode 700) via the image itself. */
function wipe(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    run('docker', [
      'run',
      '--rm',
      '-v',
      `${dir}:/wipe`,
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      'rm -rf /wipe/* /wipe/.[!.]*',
    ]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** PID of the Node process in the running compose container (its `comm` is `node`). */
function nodePid(): string {
  const r = exec('pgrep -x node');
  const pids = r.stdout.trim().split(/\s+/).filter(Boolean);
  assert(r.code === 0 && pids.length === 1, `expected exactly one node process, got: ${r.out.trim()}`);
  return pids[0] ?? '';
}

async function waitHealthy(timeoutMs: number): Promise<number> {
  const started = Date.now();
  const id = compose(['ps', '-q', 'kalshi-trader']).stdout.trim();
  assert(id !== '', 'container is not running');
  let status = '';
  while (Date.now() - started < timeoutMs) {
    status = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', id]).stdout.trim();
    if (status === 'healthy') return Date.now() - started;
    await sleep(1000);
  }
  throw new Error(
    `health is "${status}" after ${timeoutMs / 1000} s:\n${compose(['logs', '--tail', '40']).out}`,
  );
}

/** GET with curl (connection closed after the response): status and body. */
function curlGet(url: string): { status: number; body: string } {
  const r = run('curl', ['-s', '-w', '\n%{http_code}', url]);
  const i = r.stdout.lastIndexOf('\n');
  return { status: Number(r.stdout.slice(i + 1)), body: r.stdout.slice(0, i) };
}

/** Writes `options.json` for a fixture `config.local.json` via `npm run compose:options`. */
function writeOptions(local: Record<string, unknown>, out: string): string {
  const localPath = join(BASE, `config.local.${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(localPath, JSON.stringify(local));
  const r = run('npm', ['run', '--silent', 'compose:options', '--', '--out', out], {
    env: { ...process.env, CONFIG_LOCAL_PATH: localPath },
  });
  assert(r.code === 0, `compose:options failed: ${r.out}`);
  return r.stdout.trim();
}

// ---- 1. check:addon --------------------------------------------------------------------------

if (want('addon')) {
  await check(
    'npm run check:addon exits 0; removing slug, an option without schema, or ports 8099/tcp: 8099 → exit 1 naming the key',
    () => {
      const ok = run('npm', ['run', '--silent', 'check:addon']);
      assert(ok.code === 0, `committed config.yaml: exit ${ok.code}\n${ok.out}`);
      mkdirSync(BASE, { recursive: true });
      const original = readFileSync(join(ADDON, 'config.yaml'), 'utf8');
      const cases: [string, string, string][] = [
        ['slug removed', original.replace(/^slug:.*\n/m, ''), 'slug'],
        [
          'option without schema',
          original.replace(/^options:\n/m, 'options:\n  extra_option: 1\n'),
          'options.extra_option',
        ],
        [
          'ports 8099/tcp: 8099',
          original.replace(/^ {2}8099\/tcp: null.*$/m, '  8099/tcp: 8099'),
          'ports.8099/tcp',
        ],
      ];
      const seen: string[] = [];
      for (const [name, text, key] of cases) {
        assert(text !== original, `${name}: mutation did not apply`);
        const path = join(BASE, 'config.mutated.yaml');
        writeFileSync(path, text);
        const r = run('npm', ['run', '--silent', 'check:addon', '--', '--config', path]);
        assert(r.code === 1, `${name}: expected exit 1, got ${r.code}\n${r.out}`);
        assert(r.out.includes(`ERROR ${key}:`), `${name}: output does not name ${key}:\n${r.out}`);
        seen.push(`${name} → exit 1 "${r.out.split('\n').find((l) => l.startsWith('ERROR'))}"`);
      }
      return `committed → exit 0; ${seen.join('; ')}`;
    },
  );
}

// ---- 2–4. docker compose: health, ownership, non-root, read-only, key hand-over ----------------

const needsCompose = ['compose', 'user', 'key', 'runsh', 'size'].some(want);
let fixtureKey = '';
if (needsCompose) {
  const build = compose(['build']);
  if (build.code !== 0) {
    record('docker compose build', 'FAIL', build.out.slice(-3000));
    finish();
  }
  compose(['down', '--remove-orphans']);
  wipe(BASE);
  mkdirSync(DATA, { recursive: true });
  fixtureKey = join(BASE, 'key.pem');
  const gen = run('openssl', [
    'genpkey',
    '-algorithm',
    'RSA',
    '-pkeyopt',
    'rsa_keygen_bits:2048',
    '-out',
    fixtureKey,
  ]);
  assert(gen.code === 0, `openssl genpkey failed: ${gen.out}`);
  writeOptions(
    { kalshiKeyId: 'verify-t05-key-id', kalshiPrivateKeyPath: fixtureKey, logLevel: 'info' },
    join(DATA, 'options.json'),
  );
}

if (want('compose')) {
  await check(
    'docker compose up --build -d → healthy within 90 s; /healthz → {"ok":true,…}; db/trader.db uid 1000; options.json still root',
    async () => {
      const up = compose(['up', '--build', '-d']);
      assert(up.code === 0, `docker compose up failed:\n${up.out.slice(-2000)}`);
      const ms = await waitHealthy(90_000);
      // curl (one request per connection), not fetch: a kept-alive connection would hold a socket fd in
      // the app and skew the "no fd 3 after boot" check below.
      const res = curlGet(`http://127.0.0.1:${HOST_PORT}/healthz`);
      const body = res.body;
      assert(res.status === 200 && body.startsWith('{"ok":true'), `/healthz → ${res.status} ${body}`);
      const dbUid = exec('stat -c %u /data/db/trader.db');
      assert(dbUid.code === 0 && dbUid.stdout.trim() === '1000', `db/trader.db owner: ${dbUid.out.trim()}`);
      // The host path is the same file (bind mount); /data/db is mode 700, so it is stat'ed from inside.
      const optionsUid = statSync(join(DATA, 'options.json')).uid;
      assert(optionsUid === 0, `.local/data/options.json is owned by uid ${optionsUid}, expected 0 (root)`);
      return `healthy after ${(ms / 1000).toFixed(1)} s; /healthz → 200 ${body}; .local/verify-T05/data/db/trader.db uid ${dbUid.stdout.trim()}; options.json uid ${optionsUid}`;
    },
  );
}

if (want('user')) {
  await check(
    'Node runs as uid 1000; touch /app/x → Read-only file system; app user writes /data/db, /data/app, not /data/options.json',
    () => {
      const literal = exec('stat -c %u /proc/$(pgrep -f dist/server/main.js)');
      const pid = nodePid();
      const uid = exec(`stat -c %u /proc/${pid}`).stdout.trim();
      assert(uid === '1000', `node (pid ${pid}) runs as uid ${uid}`);
      const touch = exec('touch /app/x');
      assert(
        touch.code !== 0 && touch.out.includes('Read-only file system'),
        `touch /app/x: ${touch.out.trim()}`,
      );
      for (const dir of ['/data/db', '/data/app']) {
        const w = exec(`touch ${dir}/.verify-t05 && rm ${dir}/.verify-t05`, '1000');
        assert(w.code === 0, `uid 1000 cannot write ${dir}: ${w.out.trim()}`);
      }
      const opt = exec('echo x >> /data/options.json', '1000');
      assert(opt.code !== 0, 'uid 1000 could write /data/options.json');
      return `node pid ${pid} uid ${uid} (literal \`stat -c %u /proc/$(pgrep -f dist/server/main.js)\` → ${JSON.stringify(literal.out.trim())}: the extra lines, if any, are the \`sh -c\` running the command, whose own command line matches the pattern); touch /app/x → "${touch.out.trim()}"; uid 1000 wrote /data/db and /data/app; /data/options.json → "${opt.out.trim()}"`;
    },
  );
}

if (want('key')) {
  await check(
    'Key never in the environment (environ grep → 0), no fd 3 after boot; dev-only endpoint fingerprint = openssl pkey -pubout | sha256sum',
    async () => {
      const pid = nodePid();
      // /proc/<pid>/environ and fd link targets of another user's process need ptrace rights, which root
      // in the container lacks (no CAP_SYS_PTRACE); read them as the app user, and make sure the read works.
      const size = exec(`wc -c < /proc/${pid}/environ`, '1000');
      assert(size.code === 0 && Number(size.stdout.trim()) > 0, `cannot read environ: ${size.out.trim()}`);
      const env = exec(
        `tr '\\0' '\\n' < /proc/${pid}/environ | grep -c -e KALSHI_PRIVATE -e 'BEGIN .*PRIVATE KEY'`,
        '1000',
      );
      assert(env.stdout.trim() === '0', `environ grep count: ${env.out.trim()}`);
      let fd3 = '';
      for (let i = 0; i < 5; i++) {
        const r = exec(`ls -l /proc/${pid}/fd/3`, '1000');
        fd3 = r.out.trim();
        if (r.code !== 0 && /No such file/.test(fd3)) break;
        await sleep(1000); // a transient socket (e.g. the health probe) may briefly hold the lowest free fd
      }
      if (!/No such file/.test(fd3)) {
        throw new Error(`fd 3 after boot: ${fd3}\n${exec(`ls -l /proc/${pid}/fd`, '1000').out}`);
      }
      const cmdline = exec(`tr '\\0' ' ' < /proc/${pid}/cmdline`).stdout.trim();

      const expected = sh(`openssl pkey -in '${fixtureKey}' -pubout | sha256sum`).stdout.split(' ')[0] ?? '';
      assert(/^[0-9a-f]{64}$/.test(expected), 'openssl fingerprint failed');
      // Same image and options, NODE_ENV=development: the endpoint exists and answers loopback only.
      compose(['down']);
      const up = compose(['up', '-d'], 'development');
      assert(up.code === 0, `docker compose up (development) failed:\n${up.out.slice(-2000)}`);
      await waitHealthy(90_000);
      const r = compose(
        ['exec', '-T', 'kalshi-trader', 'wget', '-qO-', 'http://127.0.0.1:8099/api/dev/key-fingerprint'],
        'development',
      );
      const got = (JSON.parse(r.stdout || '{}') as { sha256?: string }).sha256;
      assert(got === expected, `endpoint → ${r.out.trim()}, openssl → ${expected}`);
      const outside = curlGet(`http://127.0.0.1:${HOST_PORT}/api/dev/key-fingerprint`);
      compose(['down']);
      const prodUp = compose(['up', '-d']);
      assert(prodUp.code === 0, 'docker compose up (production) failed');
      await waitHealthy(90_000);
      const prod = compose([
        'exec',
        '-T',
        'kalshi-trader',
        'wget',
        '-qO-',
        '-S',
        'http://127.0.0.1:8099/api/dev/key-fingerprint',
      ]);
      assert(!prod.out.includes(expected), 'production serves the fingerprint');
      return `environ grep -c → ${env.stdout.trim()}; ls -l /proc/${pid}/fd/3 → "${fd3}"; cmdline "${cmdline}"; development endpoint sha256 ${got} = openssl ${expected}; from the host (not loopback inside the container) → ${outside.status}; production → not served`;
    },
  );
}

// ---- 5. run.sh with fixture options.json ------------------------------------------------------

if (want('runsh')) {
  await check(
    'run.sh exports KALSHI_ENV, KALSHI_KEY_ID, KALSHI_SUBACCOUNT, ALLOW_LIVE_ORDERS, LOG_LEVEL, TRUSTED_PROXIES; timezone absent → TZ unchanged, present → exported',
    async () => {
      const results: string[] = [];
      for (const [name, timezone] of [
        ['absent', undefined],
        ['present', 'Europe/Prague'],
      ] as const) {
        const dir = join(BASE, `runsh-${name}`);
        wipe(dir);
        mkdirSync(dir, { recursive: true });
        const local = {
          kalshiEnv: 'prod',
          kalshiKeyId: 'fixture-key-id',
          kalshiPrivateKeyPath: fixtureKey,
          kalshiSubaccount: 7,
          allowLiveOrders: false,
          logLevel: 'warn',
          trustedProxies: '172.30.32.0/23,10.1.2.0/24',
          ...(timezone ? { tz: timezone } : {}),
        };
        writeOptions(local, join(dir, 'options.json'));
        // options.json is root-only (mode 600), like on Home Assistant: read it as root in a container.
        const options = JSON.parse(
          run('docker', [
            'run',
            '--rm',
            '-v',
            `${dir}:/data`,
            '--entrypoint',
            'cat',
            IMAGE,
            '/data/options.json',
          ]).stdout,
        ) as Record<string, unknown>;
        const cname = `kst-verify-t05-runsh-${name}`;
        run('docker', ['rm', '-f', cname]);
        const start = run('docker', [
          'run',
          '-d',
          '--name',
          cname,
          '--init',
          '--read-only',
          '--tmpfs',
          '/tmp',
          '-e',
          'TZ=America/New_York',
          '-v',
          `${dir}:/data`,
          IMAGE,
        ]);
        assert(start.code === 0, `docker run failed: ${start.out}`);
        try {
          let environ = '';
          for (let i = 0; i < 30 && environ === ''; i++) {
            await sleep(500);
            const r = run('docker', [
              'exec',
              '-u',
              '1000',
              cname,
              'sh',
              '-c',
              `tr '\\0' '\\n' < /proc/$(pgrep -x node)/environ`,
            ]);
            if (r.code === 0) environ = r.stdout;
          }
          assert(environ !== '', `node did not start:\n${run('docker', ['logs', cname]).out}`);
          const env = Object.fromEntries(
            environ
              .split('\n')
              .filter(Boolean)
              .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
          );
          const expect: Record<string, string> = {
            KALSHI_ENV: String(options['kalshi_env']),
            KALSHI_KEY_ID: String(options['kalshi_key_id']),
            KALSHI_SUBACCOUNT: String(options['kalshi_subaccount']),
            ALLOW_LIVE_ORDERS: String(options['allow_live_orders']),
            LOG_LEVEL: String(options['log_level']),
            TRUSTED_PROXIES: String(options['trusted_proxies']),
            TZ: timezone ?? 'America/New_York',
          };
          for (const [k, v] of Object.entries(expect)) {
            assert(
              env[k] === v,
              `timezone ${name}: ${k}=${JSON.stringify(env[k])}, expected ${JSON.stringify(v)}`,
            );
          }
          assert(
            !Object.keys(env).some((k) => k.startsWith('KALSHI_PRIVATE')),
            `timezone ${name}: a KALSHI_PRIVATE* variable is in the environment`,
          );
          results.push(
            `timezone ${name}: ${Object.entries(expect)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')}`,
          );
        } finally {
          run('docker', ['rm', '-f', cname]);
        }
      }
      return `${results.join('; ')} (container TZ=America/New_York)`;
    },
  );
}

// ---- 6. arm64 ---------------------------------------------------------------------------------

if (want('arm64')) {
  await check(
    'docker buildx build --platform linux/arm64 --load succeeds; better-sqlite3 opens :memory: under arm64',
    () => {
      const build = run(
        'docker',
        [
          'buildx',
          'build',
          '--platform',
          'linux/arm64',
          '-t',
          'kalshi-trader:arm64',
          '--load',
          'kalshi-trader/',
        ],
        {
          cwd: ROOT,
        },
      );
      assert(build.code === 0, `arm64 build failed:\n${build.out.slice(-3000)}`);
      const r = run('docker', [
        'run',
        '--rm',
        '--platform',
        'linux/arm64',
        '--entrypoint',
        'node',
        'kalshi-trader:arm64',
        '-e',
        "require('/app/node_modules/better-sqlite3')(':memory:').prepare('select 1').get()",
      ]);
      assert(r.code === 0, `node -e exit ${r.code}: ${r.out}`);
      const arch = run('docker', [
        'run',
        '--rm',
        '--platform',
        'linux/arm64',
        '--entrypoint',
        'sh',
        'kalshi-trader:arm64',
        '-c',
        'uname -m; node --version',
      ]);
      return `built; node -e … exit 0 (${arch.stdout.trim().replace(/\n/g, ', ')})`;
    },
  );
}

// ---- 7. size and production dependencies ------------------------------------------------------

if (want('size')) {
  await check('amd64 image < 350 MB; no dev dependencies in /app/node_modules (grep -c vitest → 0)', () => {
    const size = Number(run('docker', ['image', 'inspect', '-f', '{{.Size}}', IMAGE]).stdout.trim());
    assert(Number.isFinite(size) && size > 0, 'image size unknown');
    assert(size < SIZE_LIMIT, `image is ${(size / 1e6).toFixed(1)} MB`);
    const vitestCount = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      'ls /app/node_modules | grep -c vitest',
    ]);
    assert(vitestCount.stdout.trim() === '0', `vitest count: ${vitestCount.out.trim()}`);
    const dev = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      'ls /app/node_modules | grep -c -x -e typescript -e vite -e eslint -e playwright -e tsx',
    ]);
    assert(dev.stdout.trim() === '0', `dev tools present: ${dev.out.trim()}`);
    const node = run('docker', ['run', '--rm', '--entrypoint', 'node', IMAGE, '--version']).stdout.trim();
    assert(/^v(2[2-9]|[3-9]\d)\./.test(node), `node ${node} < 22`);
    return `${(size / 1e6).toFixed(1)} MB (${size} bytes); vitest → 0; typescript/vite/eslint/playwright/tsx → 0; node ${node}`;
  });
}

// ---- 8–9. config.yaml vs §11, DOCS.md headings, translations ------------------------------------

if (want('config')) {
  await check('config.yaml matches §11 field for field', () => {
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
    const block = /### `config\.yaml`\n\n```yaml\n([\s\S]*?)```/.exec(spec)?.[1];
    assert(block !== undefined, '§11 config.yaml block not found');
    mkdirSync(BASE, { recursive: true });
    writeFileSync(join(BASE, 'spec-config.yaml'), block);
    const diff = run('diff', ['-u', join(BASE, 'spec-config.yaml'), join(ADDON, 'config.yaml')]);
    const same =
      JSON.stringify(parse(block)) ===
      JSON.stringify(parse(readFileSync(join(ADDON, 'config.yaml'), 'utf8')));
    assert(same, `parsed documents differ:\n${diff.out}`);
    return `diff -u <§11 block> kalshi-trader/config.yaml → ${diff.code === 0 ? 'no differences (byte-identical)' : `\n${diff.out}`}; parsed documents equal`;
  });
}

if (want('docs')) {
  await check(
    'DOCS.md has a heading for every Scope item; translations/en.yaml has name + description for every option',
    () => {
      const detail = vitest(['test/unit/addon-packaging.test.ts'], 'translations/en.yaml and DOCS.md');
      const headings = [...readFileSync(join(ADDON, 'DOCS.md'), 'utf8').matchAll(/^## (.+)$/gm)].map(
        (m) => m[1],
      );
      return `${detail}; headings: ${headings.join(' | ')}`;
    },
  );
}

if (!only)
  record(
    'CI image.yml green for both platforms',
    'MANUAL',
    'see the GitHub Actions run recorded in docs/verification/T05.md',
  );

if (needsCompose && !argv.includes('--keep')) compose(['down', '--remove-orphans']);
finish();
