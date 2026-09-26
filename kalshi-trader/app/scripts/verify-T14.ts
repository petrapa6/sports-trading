/**
 * `npm run verify:T14` — runs the T14 acceptance checks (SPEC.md §14) and prints PASS / FAIL / MANUAL per item.
 *
 *   npm run verify:T14                        # everything that runs on this machine
 *   npm run verify:T14 -- --only=container    # only the container item (CI job "amd64" in image.yml)
 *   npm run verify:T14 -- --skip=container,e2e
 *
 * Items: audit (npm run audit:security + the two mutations), container (compose: CapEff, read-only root,
 * no-new-privileges; needs Docker and the base image), drills (scripts/drills/*, ~3 min, and the drill endpoints
 * against a production build), maintenance, migrate (down/up on a seeded DB), size (seed:season), e2e
 * (npm run e2e + npm run lighthouse:a11y), release (versions, CHANGELOG, check:addon), haos (the checklist).
 * Scratch data lives in `.local/verify-T14/`; nothing touches your own database.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { APP, ROOT, assert, check, cleanEnv, finish, record, run, sleep, vitest } from './verify-lib.js';

const argv = process.argv.slice(2);
const listArg = (name: string) =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(',');
const only = listArg('only');
const skip = listArg('skip') ?? [];
const want = (item: string) => (only ? only.includes(item) : !skip.includes(item));

const SCRATCH = join(APP, '.local/verify-T14');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const hasGitleaks = run(process.env['GITLEAKS'] ?? 'gitleaks', ['version']).code === 0;

// ---- 1. npm run audit:security ----------------------------------------------------------------------------------

if (want('audit')) {
  await check(
    'npm run audit:security exits 0 with one line per check; unsafe-inline in the CSP or X-Frame-Options missing on tunnel responses → exit 1',
    () => {
      const flags = hasGitleaks ? [] : ['--skip-gitleaks'];
      const ok = run('npm', ['run', '--silent', 'audit:security', '--', ...flags]);
      assert(ok.code === 0, `exit ${ok.code}\n${ok.out.slice(-3000)}`);
      assert(hasGitleaks, 'gitleaks is not installed here, so the gitleaks check was skipped');
      const lines = ok.stdout.split('\n').filter((l) => /^(PASS|FAIL|SKIP) /.test(l));
      assert(lines.length === 7, `expected 7 check lines, got ${lines.length}`);

      // The two mutations, applied to the working tree and always restored.
      const file = join(APP, 'src/server/security.ts');
      const original = readFileSync(file, 'utf8');
      const mutations: [string, string, RegExp][] = [
        [
          "style-src 'unsafe-inline'",
          original.replace(`styleSrc: ["'self'"],`, `styleSrc: ["'self'", "'unsafe-inline'"],`),
          /CSP allows 'unsafe-inline'/,
        ],
        [
          'no X-Frame-Options on tunnel responses',
          original.replace(
            "reply.header('x-frame-options', c.class === 'ingress' ? 'SAMEORIGIN' : 'DENY');",
            "if (c.class !== 'tunnel') reply.header('x-frame-options', c.class === 'ingress' ? 'SAMEORIGIN' : 'DENY');",
          ),
          /FAIL headers: tunnel .*X-Frame-Options \(missing\)/,
        ],
      ];
      const seen: string[] = [];
      try {
        for (const [name, text, needle] of mutations) {
          assert(text !== original, `${name}: the mutation did not apply`);
          writeFileSync(file, text);
          const r = run('npm', ['run', '--silent', 'audit:security', '--', '--skip-gitleaks']);
          assert(r.code === 1, `${name}: expected exit 1, got ${r.code}`);
          assert(needle.test(r.stdout), `${name}: no matching FAIL line:\n${r.stdout.slice(-2000)}`);
          const failed = r.stdout
            .split('\n')
            .filter((l) => l.startsWith('FAIL '))
            .map((l) => l.slice(5, l.indexOf(' — ')));
          seen.push(`${name} → exit 1 (FAIL: ${failed.join('; ')})`);
        }
      } finally {
        writeFileSync(file, original);
        run('npm', ['run', 'build']);
      }
      return `${lines.length} lines, exit 0; ${seen.join('; ')}`;
    },
  );
}

// ---- 2. container: capabilities, read-only root, no-new-privileges ------------------------------------------------

if (want('container')) {
  await check(
    'Container (docker compose): node CapEff shows no capabilities; touch /app/x → read-only error; no cap_add / privileged',
    async () => {
      const project = 'kst-verify-t14';
      const data = join(SCRATCH, 'compose-data');
      mkdirSync(data, { recursive: true });
      const env = { ...process.env, KST_DATA_DIR: data, KST_HOST_PORT: '8189' };
      const compose = (args: string[]) =>
        run('docker', ['compose', '-f', join(ROOT, 'docker-compose.yml'), '-p', project, ...args], {
          cwd: ROOT,
          env,
        });
      const opts = run(
        'npm',
        ['run', '--silent', 'compose:options', '--', '--out', join(data, 'options.json')],
        {
          env: cleanEnv({ CONFIG_LOCAL_PATH: '/nonexistent/config.local.json' }),
        },
      );
      assert(opts.code === 0, `compose:options: ${opts.out}`);
      const cfg = parse(compose(['config']).stdout) as {
        services: Record<
          string,
          { cap_add?: unknown; privileged?: boolean; security_opt?: string[]; read_only?: boolean }
        >;
      };
      const svc = cfg.services['kalshi-trader'];
      assert(svc && svc.cap_add === undefined && !svc.privileged, `compose config: ${JSON.stringify(svc)}`);
      assert(svc.read_only === true, 'read_only is not true');
      assert(svc.security_opt?.includes('no-new-privileges:true'), 'no-new-privileges is not set');
      try {
        const up = compose(['up', '--build', '-d']);
        assert(up.code === 0, `docker compose up failed:\n${up.out.slice(-2500)}`);
        let health = '';
        for (let i = 0; i < 90 && health !== 'healthy'; i++) {
          await sleep(1000);
          const id = compose(['ps', '-q', 'kalshi-trader']).stdout.trim();
          health = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', id]).stdout.trim();
        }
        assert(health === 'healthy', `container health: ${health}\n${compose(['logs', '--tail', '30']).out}`);
        const exec = (cmd: string) => compose(['exec', '-T', 'kalshi-trader', 'sh', '-c', cmd]);
        const pid = exec('pgrep -x node').stdout.trim();
        assert(/^\d+$/.test(pid), `node pid: ${pid}`);
        const status = exec(
          `grep -E '^(Uid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):' /proc/${pid}/status`,
        ).stdout;
        const field = (k: string) => new RegExp(`^${k}:\\s*(\\S+)`, 'm').exec(status)?.[1] ?? '';
        assert(field('CapEff') === '0000000000000000', `CapEff ${field('CapEff')}`);
        assert(field('CapPrm') === '0000000000000000', `CapPrm ${field('CapPrm')}`);
        assert(field('NoNewPrivs') === '1', `NoNewPrivs ${field('NoNewPrivs')}`);
        const uid = /^Uid:\s*(\d+)/m.exec(status)?.[1];
        assert(uid === '1000', `uid ${uid}`);
        const touch = exec('touch /app/x');
        assert(touch.code !== 0 && touch.out.includes('Read-only file system'), `touch /app/x: ${touch.out}`);
        // The bounding set of a default Docker container: the capabilities Docker grants, none added.
        const docker = run('docker', [
          'inspect',
          '-f',
          '{{json .HostConfig.CapAdd}} {{.HostConfig.Privileged}}',
          compose(['ps', '-q', 'kalshi-trader']).stdout.trim(),
        ]);
        return `node pid ${pid} uid ${uid}: CapEff ${field('CapEff')}, CapPrm ${field('CapPrm')}, CapAmb ${field('CapAmb')}, NoNewPrivs ${field('NoNewPrivs')} (CapBnd ${field('CapBnd')}: Docker's default set, CapAdd/Privileged = ${docker.stdout.trim()}); touch /app/x → "${touch.out.trim()}"`;
      } finally {
        compose(['down', '--remove-orphans']);
        run('docker', [
          'run',
          '--rm',
          '-v',
          `${data}:/wipe`,
          '--entrypoint',
          'sh',
          'kalshi-trader:local',
          '-c',
          'rm -rf /wipe/*',
        ]);
      }
    },
  );
}

// ---- 3. drills -------------------------------------------------------------------------------------------------

if (want('drills')) {
  const drill = (name: string) => {
    const r = run('npx', ['tsx', `scripts/drills/${name}.ts`]);
    assert(r.code === 0 && r.stdout.includes(`DRILL ${name}: PASSED`), r.out.slice(-2500));
    return r.stdout
      .split('\n')
      .filter((l) => l.startsWith('ok '))
      .map((l) => l.slice(5))
      .join('; ');
  };
  await check('(a) stall-scheduler → /healthz 503 within 2 min, then 200 after resume', () =>
    drill('stall-scheduler'),
  );
  await check('(b) exclusive SQLite lock for 10 s → 503 {"error":"db_busy"}, then recovery', () =>
    drill('db-lock'),
  );
  await check(
    '(c) Kalshi 503 for 10 min of fake time → feeds still polled, attempts error, first successful call logged',
    () => drill('kalshi-down'),
  );
  await check('(d) global kill switch → zero requests (msw + feed mocks), /healthz paused', () =>
    drill('kill-switch'),
  );
  await check('Drill endpoints return 404 in a production build (and exist in development)', async () => {
    const unit = vitest(['test/security/drills.test.ts']);
    const build = run('npm', ['run', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const dir = join(SCRATCH, 'prod-drills');
    const env = (nodeEnv: string) =>
      cleanEnv({
        NODE_ENV: nodeEnv,
        PORT: '8297',
        DB_PATH: join(dir, 'trader.db'),
        DATA_DIR: join(dir, 'data'),
        LOG_LEVEL: 'warn',
      });
    const start = async (nodeEnv: string) => {
      const child = spawn(process.execPath, ['dist/server/main.js'], {
        cwd: APP,
        env: env(nodeEnv),
        stdio: 'ignore',
      });
      for (let i = 0; i < 100; i++) {
        try {
          await fetch('http://127.0.0.1:8297/healthz');
          return child;
        } catch {
          await sleep(200);
        }
      }
      child.kill('SIGKILL');
      throw new Error(`dist/server/main.js (${nodeEnv}) did not start`);
    };
    const stop = async (child: ReturnType<typeof spawn>) => {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    };
    const base = 'http://127.0.0.1:8297';
    // Development build of the same dist: first-run setup (class dev), and the drill endpoint exists.
    let child = await start('development');
    const setup = await fetch(`${base}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'verify', password: 'verify T14 password' }),
    });
    assert(setup.status === 201, `setup → ${setup.status}`);
    const devStall = await fetch(`${base}/api/dev/drills/stall-scheduler`, { method: 'POST' });
    await stop(child);
    assert(devStall.status === 200, `development → ${devStall.status}`);
    // Production: sign in (class other), then the same endpoint with a session and a CSRF token → 404.
    child = await start('production');
    try {
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'verify', password: 'verify T14 password' }),
      });
      assert(login.status === 200, `login → ${login.status}`);
      const cookie = login.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const csrf = (await (await fetch(`${base}/api/csrf`, { headers: { cookie } })).json()) as {
        token: string;
      };
      const results: string[] = [];
      for (const path of ['/api/dev/drills/stall-scheduler', '/api/dev/drills/resume-scheduler']) {
        const r = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { cookie, 'x-csrf-token': csrf.token, 'content-type': 'application/json' },
          body: '{}',
        });
        const body = await r.text();
        assert(r.status === 404 && body === '{"error":"not_found"}', `${path} → ${r.status} ${body}`);
        results.push(`${path} → 404`);
      }
      return `dist/server/main.js NODE_ENV=development → stall-scheduler 200; NODE_ENV=production, signed in: ${results.join(', ')}; ${unit}`;
    } finally {
      await stop(child);
    }
  });
}

// ---- 4. maintenance --------------------------------------------------------------------------------------------

if (want('maintenance')) {
  await check(
    'Maintenance: fake time crossing 02:30 logs wal_checkpoint and "pruned N snapshots"; -wal < 1 MB on the seeded DB; non-archived snapshots survive',
    () => {
      const r = run('npx', ['vitest', 'run', 'test/unit/maintenanceSeason.test.ts', '--silent=false']);
      assert(r.code === 0, r.out.slice(-2000));
      return r.out.split('\n').find((l) => l.startsWith('seeded ')) ?? 'passed';
    },
  );
}

// ---- 5–6. seeded season: migrations down/up, size --------------------------------------------------------------

const seasonDb = join(SCRATCH, 'season/trader.db');
const seasonEnv = cleanEnv({ DB_PATH: seasonDb });
const counts = () => {
  const r = run(
    process.execPath,
    [
      '-e',
      `const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});const o={};` +
        `for(const {name} of d.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name").all())` +
        `o[name]=d.prepare('select count(*) n from "'+name+'"').get().n;console.log(JSON.stringify(o))`,
      seasonDb,
    ],
    {},
  );
  assert(r.code === 0, r.out);
  return JSON.parse(r.stdout) as Record<string, number>;
};
let seedOut = '';
if (want('size') || want('migrate')) {
  const r = run('npm', ['run', '--silent', 'seed:season'], { env: seasonEnv });
  seedOut = r.out;
  if (r.code !== 0) record('npm run seed:season', 'FAIL', r.out.slice(-2000));
}

if (want('size')) {
  await check(
    'npm run seed:season (2 000 games, 60 000 snapshots, 400 trades) then checkpoint → trader.db < 200 MB',
    () => {
      const c = counts();
      assert(c['games'] === 2000 && c['game_snapshots'] === 60_000 && c['trades'] === 400, JSON.stringify(c));
      const size = statSync(seasonDb).size;
      const wal = existsSync(`${seasonDb}-wal`) ? statSync(`${seasonDb}-wal`).size : 0;
      assert(size < 200_000_000, `trader.db is ${size} bytes`);
      return `${seedOut
        .split('\n')
        .filter((l) => l.includes('after wal_checkpoint'))
        .join(' ')
        .replace(
          /^\[seed:season\] /,
          '',
        )}; games ${c['games']}, snapshots ${c['game_snapshots']}, trades ${c['trades']}; -wal ${wal} bytes`;
    },
  );
}

if (want('migrate')) {
  await check('npm run db:migrate:down && npm run db:migrate on a seeded DB keeps row counts', () => {
    const before = counts();
    const down = run('npm', ['run', '--silent', 'db:migrate:down'], { env: seasonEnv });
    assert(down.code === 0, down.out);
    const up = run('npm', ['run', '--silent', 'db:migrate'], { env: seasonEnv });
    assert(up.code === 0, up.out);
    const after = counts();
    assert(
      JSON.stringify(before) === JSON.stringify(after),
      `before ${JSON.stringify(before)}\nafter ${JSON.stringify(after)}`,
    );
    const msg = (out: string) => (JSON.parse(out.trim().split('\n').pop() ?? '{}') as { msg?: string }).msg;
    return `${msg(down.stdout)} → ${msg(up.stdout)}; ${Object.keys(after).length} tables, counts unchanged (games ${after['games']}, game_snapshots ${after['game_snapshots']}, trades ${after['trades']}, trade_attempts ${after['trade_attempts']})`;
  });
}

// ---- 7. e2e + Lighthouse ---------------------------------------------------------------------------------------

if (want('e2e')) {
  await check('npm run e2e green at both widths', () => {
    const r = run('npm', ['run', 'e2e', '--', '--reporter=line']);
    assert(r.code === 0, r.out.slice(-3000));
    return `${/(\d+) passed/.exec(r.out)?.[1] ?? '?'} passed (desktop 1280 px + mobile 390 px projects)`;
  });
  await check('Lighthouse accessibility ≥ 90 on Dashboard and Trades', () => {
    const r = run('npm', ['run', '--silent', 'lighthouse:a11y', '--', '--no-build']);
    assert(r.code === 0, r.out.slice(-2000));
    return r.stdout.trim().split('\n').join('; ');
  });
}

// ---- 8. release ------------------------------------------------------------------------------------------------

if (want('release')) {
  await check(
    'config.yaml, package.json and the top CHANGELOG.md heading all read 1.0.0; npm run check:addon passes',
    () => {
      const cfg = parse(readFileSync(join(ROOT, 'kalshi-trader/config.yaml'), 'utf8')) as { version: string };
      const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { version: string };
      const lock = JSON.parse(readFileSync(join(APP, 'package-lock.json'), 'utf8')) as { version: string };
      const top = readFileSync(join(ROOT, 'kalshi-trader/CHANGELOG.md'), 'utf8')
        .split('\n')
        .find((l) => l.startsWith('## '));
      const label = /io\.hass\.version="([^"]+)"/.exec(
        readFileSync(join(ROOT, 'kalshi-trader/Dockerfile'), 'utf8'),
      )?.[1];
      assert(
        cfg.version === '1.0.0' && pkg.version === '1.0.0' && lock.version === '1.0.0',
        `${cfg.version} ${pkg.version} ${lock.version}`,
      );
      assert(top?.startsWith('## 1.0.0'), `top CHANGELOG heading: ${top}`);
      assert(label === '1.0.0', `Dockerfile io.hass.version ${label}`);
      const addon = run('npm', ['run', '--silent', 'check:addon']);
      assert(addon.code === 0, addon.out);
      return `config.yaml ${cfg.version}, package.json ${pkg.version} (lock ${lock.version}), Dockerfile label ${label}, CHANGELOG "${top}"; check:addon exit 0`;
    },
  );
  record(
    'arm64 and amd64 images build in CI',
    'MANUAL',
    'the Image workflow (.github/workflows/image.yml, job "multiarch") on the pushed branch; result recorded in docs/verification/T14.md',
  );
}

// ---- 9. HAOS checklist -----------------------------------------------------------------------------------------

if (want('haos')) {
  await check('docs/verification/HAOS.md exists with the 10-step checklist', () => {
    const path = join(ROOT, 'docs/verification/HAOS.md');
    assert(existsSync(path), 'missing');
    const text = readFileSync(path, 'utf8');
    const steps = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    for (let i = 1; i <= 10; i++) assert(steps.includes(i), `step ${i} missing`);
    for (const needle of [
      'subaccount',
      'https://github.com/petrapa6/sports-trading',
      'allow_live_orders: false',
      'kill switch',
      'db/trader.db',
      '/setup',
      'maxStakeUsd',
    ])
      assert(text.includes(needle), `"${needle}" not mentioned`);
    return `${Math.max(...steps)} steps`;
  });
}

finish();
