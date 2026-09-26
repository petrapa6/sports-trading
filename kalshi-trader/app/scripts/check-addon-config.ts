/**
 * `npm run check:addon` — static checks of the Home Assistant app manifest `kalshi-trader/config.yaml`
 * (SPEC.md §11, T05). Prints every problem as `ERROR <key>: <reason>` and exits 1, or prints `OK` and
 * exits 0.
 *
 *   npm run check:addon                              # ../config.yaml, ../run.sh, ./package.json
 *   npm run check:addon -- --config other.yaml       # another manifest (tests)
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export interface AddonProblem {
  /** The offending key, e.g. `slug`, `ports.8099/tcp`, `options.foo`. */
  key: string;
  reason: string;
}

export interface AddonInputs {
  /** Text of `config.yaml`. */
  configYaml: string;
  /** `version` from `package.json`. */
  packageVersion: string;
  /** The port the app listens on (`PORT` exported by `run.sh`). */
  port: number | undefined;
}

const REQUIRED = [
  'name',
  'version',
  'slug',
  'description',
  'url',
  'arch',
  'startup',
  'boot',
  'init',
  'ingress',
  'ingress_port',
  'ports',
  'options',
  'schema',
] as const;

/** Keys that would widen the app's privileges; none may be set (SPEC.md §10 Container). */
const FORBIDDEN = ['host_network', 'privileged', 'full_access', 'hassio_api'] as const;

const APP_PORT = '8099/tcp';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads `PORT=<n>` from `run.sh`. */
export function portFromRunSh(runSh: string): number | undefined {
  const m = /\bPORT=(\d+)\b/.exec(runSh);
  return m?.[1] === undefined ? undefined : Number.parseInt(m[1], 10);
}

export function checkAddonConfig(inputs: AddonInputs): AddonProblem[] {
  const problems: AddonProblem[] = [];
  const add = (key: string, reason: string) => problems.push({ key, reason });

  let doc: unknown;
  try {
    doc = parse(inputs.configYaml);
  } catch (err) {
    add('config.yaml', `is not valid YAML (${(err as Error).message.split('\n')[0] ?? ''})`);
    return problems;
  }
  if (!isRecord(doc)) {
    add('config.yaml', 'must be a YAML mapping');
    return problems;
  }

  for (const key of REQUIRED) {
    if (doc[key] === undefined) add(key, 'is required but missing');
  }

  if (doc['slug'] !== undefined && !(typeof doc['slug'] === 'string' && /^[a-z0-9_-]+$/.test(doc['slug']))) {
    add('slug', 'must be lower-case letters, digits, "-" or "_"');
  }

  // options ↔ schema parity: every option has a schema entry; every non-optional schema entry has an option.
  const options = doc['options'];
  const schema = doc['schema'];
  if (options !== undefined && !isRecord(options)) add('options', 'must be a mapping');
  if (schema !== undefined && !isRecord(schema)) add('schema', 'must be a mapping');
  if (isRecord(options) && isRecord(schema)) {
    for (const key of Object.keys(options)) {
      if (!(key in schema)) add(`options.${key}`, 'has no schema entry');
    }
    for (const [key, type] of Object.entries(schema)) {
      const optional = typeof type === 'string' && type.trim().endsWith('?');
      if (!optional && !(key in options))
        add(`schema.${key}`, 'is not optional ("?") but has no default in options');
    }
  }

  if (doc['ingress'] !== undefined && doc['ingress'] !== true) add('ingress', 'must be true');
  if (doc['ingress_port'] !== undefined) {
    if (inputs.port === undefined) add('ingress_port', 'cannot be compared: run.sh does not export PORT=<n>');
    else if (doc['ingress_port'] !== inputs.port) {
      add(
        'ingress_port',
        `must equal PORT exported by run.sh (${inputs.port}), got ${String(doc['ingress_port'])}`,
      );
    }
  }

  const ports = doc['ports'];
  if (ports !== undefined) {
    if (!isRecord(ports)) add('ports', 'must be a mapping');
    else {
      if (!(APP_PORT in ports)) add(`ports.${APP_PORT}`, 'must be listed (with the value null)');
      for (const [port, host] of Object.entries(ports)) {
        if (host !== null) {
          add(
            `ports.${port}`,
            `must be null (unmapped: reached only via ingress and cloudflared), got ${String(host)}`,
          );
        }
      }
    }
  }

  if (doc['init'] !== undefined && doc['init'] !== true) add('init', 'must be true (Docker init as PID 1)');

  const map = doc['map'];
  if (map !== undefined && map !== null && !(Array.isArray(map) && map.length === 0)) {
    add('map', 'must be absent or empty: everything lives in the app’s own /data');
  }

  for (const key of FORBIDDEN) {
    const v = doc[key];
    const unset = v === undefined || v === false || v === null || (Array.isArray(v) && v.length === 0);
    if (!unset) add(key, 'must not be set');
  }

  if (doc['version'] !== undefined && String(doc['version']) !== inputs.packageVersion) {
    add(
      'version',
      `must equal package.json version (${inputs.packageVersion}), got ${String(doc['version'])}`,
    );
  }

  return problems;
}

function main(argv: string[]): number {
  const app = resolve(import.meta.dirname, '..');
  const i = argv.indexOf('--config');
  const configPath = resolve((i >= 0 ? argv[i + 1] : undefined) ?? join(app, '../config.yaml'));
  const runShPath = join(app, '../run.sh');
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { version: string };

  let configYaml: string;
  try {
    configYaml = readFileSync(configPath, 'utf8');
  } catch (err) {
    console.error(
      `ERROR config.yaml: cannot read ${configPath} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
    return 1;
  }
  let port: number | undefined;
  try {
    port = portFromRunSh(readFileSync(runShPath, 'utf8'));
  } catch {
    port = undefined;
  }

  const problems = checkAddonConfig({ configYaml, packageVersion: pkg.version, port });
  for (const p of problems) console.error(`ERROR ${p.key}: ${p.reason}`);
  if (problems.length > 0) {
    console.error(`${configPath}: ${problems.length} problem(s)`);
    return 1;
  }
  console.log(`OK ${configPath}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
