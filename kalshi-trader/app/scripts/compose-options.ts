/**
 * `npm run compose:options` — writes the `/data/options.json` that the Supervisor would write, for local
 * `docker compose` runs (SPEC.md §12), from `config.local.json` (or `$CONFIG_LOCAL_PATH`).
 *
 *   npm run compose:options                      # → <repo>/.local/data/options.json
 *   npm run compose:options -- --out <file>      # another location (verify:T05 uses a scratch dir)
 *
 * The private key is read from `kalshiPrivateKeyPath` and stored base64-encoded on one line, as in the
 * Configuration tab. Like on Home Assistant the file is root-owned with mode 600, so the app (uid 1000)
 * can neither read nor write it; `run.sh` (root) reads it. When not run as root, `sudo -n chown` is tried.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig, type Config } from '../src/config.js';

/** The app options (`config.yaml` `options` / `schema` keys) for a validated configuration. */
export function toAddonOptions(config: Config, readKey: (path: string) => Buffer): Record<string, unknown> {
  const options: Record<string, unknown> = {
    kalshi_env: config.kalshiEnv,
    kalshi_key_id: config.kalshiKeyId ?? '',
    kalshi_private_key_b64:
      config.kalshiPrivateKeyPath === undefined
        ? ''
        : readKey(config.kalshiPrivateKeyPath).toString('base64'),
    kalshi_subaccount: config.kalshiSubaccount,
    allow_live_orders: config.allowLiveOrders,
    log_level: config.logLevel,
    trusted_proxies: config.trustedProxies.join(','),
  };
  if (config.tz !== undefined) options['timezone'] = config.tz;
  return options;
}

function main(argv: string[]): number {
  const app = resolve(import.meta.dirname, '..');
  const i = argv.indexOf('--out');
  const out = resolve((i >= 0 ? argv[i + 1] : undefined) ?? join(app, '../../.local/data/options.json'));

  let config: Config;
  try {
    // Only config.local.json and defaults: environment variables of this shell must not leak in.
    config = loadConfig({
      env: { CONFIG_LOCAL_PATH: process.env['CONFIG_LOCAL_PATH'] ?? join(app, 'config.local.json') },
      argv: [],
    }).config;
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : String(err));
    return 1;
  }

  let options: Record<string, unknown>;
  try {
    options = toAddonOptions(config, (path) => readFileSync(path));
  } catch (err) {
    console.error(`kalshiPrivateKeyPath cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    return 1;
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(options, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  let owner = 'root';
  if (process.getuid?.() === 0) chownSync(out, 0, 0);
  else if (spawnSync('sudo', ['-n', 'chown', '0:0', out], { stdio: 'ignore' }).status !== 0) {
    owner = `uid ${process.getuid?.() ?? '?'}`;
    console.warn(
      `warning: ${out} is owned by ${owner}, not root (sudo -n chown failed); on Home Assistant it is root-owned`,
    );
  }
  console.log(
    `wrote ${out} (mode 600, owner ${owner}): ${Object.keys(options).join(', ')}; private key ${
      options['kalshi_private_key_b64'] === '' ? 'not set' : 'set'
    }`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
