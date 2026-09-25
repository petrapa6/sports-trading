import { closeSync, existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Process configuration.
 *
 * Sources, highest precedence first:
 *   1. environment variables (set by `run.sh` inside Home Assistant),
 *   2. `config.local.json` (local development only, git-ignored),
 *   3. built-in defaults.
 *
 * Empty environment variables count as unset (`run.sh` exports empty strings for
 * blank options). Invalid values fail fast with an error naming the offending key.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const KALSHI_ENVS = ['demo', 'prod'] as const;
export type KalshiEnv = (typeof KALSHI_ENVS)[number];

export const DEFAULT_CONFIG_LOCAL_PATH = 'config.local.json';

const nonEmptyString = z.string().trim().min(1, 'must not be empty');

const intFromEnv = (min: number, max: number) =>
  z
    .union(
      [
        z.number(),
        z
          .string()
          .trim()
          .regex(/^-?\d+$/, 'must be an integer')
          .transform((s) => Number.parseInt(s, 10)),
      ],
      { error: `must be an integer between ${min} and ${max}` },
    )
    .pipe(
      z
        .number()
        .int('must be an integer')
        .min(min, `must be between ${min} and ${max}`)
        .max(max, `must be between ${min} and ${max}`),
    );

const boolFromEnv = z.union([z.boolean(), z.enum(['true', 'false']).transform((s) => s === 'true')], {
  error: 'must be "true" or "false"',
});

const oneOf = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, { error: `must be one of ${values.join('|')}` });

function isValidCidr(entry: string): boolean {
  const [ip, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || ip === undefined) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const n = Number.parseInt(prefix, 10);
  return n >= 0 && n <= (family === 4 ? 32 : 128);
}

const cidrList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter((s) => s.length > 0))
  .pipe(
    z
      .array(z.string().refine(isValidCidr, 'must be a comma-separated list of IPs or CIDR ranges'))
      .min(1, 'must contain at least one IP or CIDR range'),
  );

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Every configuration key: its `config.local.json` name, its environment variable and its schema. */
const FIELDS = {
  kalshiEnv: { env: 'KALSHI_ENV', schema: oneOf(KALSHI_ENVS), default: 'demo' },
  kalshiKeyId: { env: 'KALSHI_KEY_ID', schema: nonEmptyString, default: undefined },
  kalshiPrivateKeyFd: {
    env: 'KALSHI_PRIVATE_KEY_FD',
    schema: intFromEnv(0, 1_000_000),
    default: undefined,
  },
  kalshiPrivateKeyPath: { env: undefined, schema: nonEmptyString, default: undefined },
  kalshiSubaccount: { env: 'KALSHI_SUBACCOUNT', schema: intFromEnv(0, 63), default: 0 },
  allowLiveOrders: { env: 'ALLOW_LIVE_ORDERS', schema: boolFromEnv, default: false },
  logLevel: { env: 'LOG_LEVEL', schema: oneOf(LOG_LEVELS), default: 'info' },
  dataDir: { env: 'DATA_DIR', schema: nonEmptyString, default: './.local/data' },
  dbPath: { env: 'DB_PATH', schema: nonEmptyString, default: './.local/trader.db' },
  port: { env: 'PORT', schema: intFromEnv(1, 65_535), default: 8099 },
  trustedProxies: { env: 'TRUSTED_PROXIES', schema: cidrList, default: '172.30.32.0/23' },
  tz: {
    env: 'TZ',
    schema: nonEmptyString.refine(isValidTimeZone, 'must be a valid IANA time zone'),
    default: undefined,
  },
} as const;

type Fields = typeof FIELDS;
export type FieldName = keyof Fields;

/** The validated configuration object. */
export const ConfigSchema = z
  .object({
    kalshiEnv: FIELDS.kalshiEnv.schema,
    kalshiKeyId: FIELDS.kalshiKeyId.schema.optional(),
    kalshiPrivateKeyFd: FIELDS.kalshiPrivateKeyFd.schema.optional(),
    kalshiPrivateKeyPath: FIELDS.kalshiPrivateKeyPath.schema.optional(),
    kalshiSubaccount: FIELDS.kalshiSubaccount.schema,
    allowLiveOrders: FIELDS.allowLiveOrders.schema,
    logLevel: FIELDS.logLevel.schema,
    dataDir: FIELDS.dataDir.schema,
    dbPath: FIELDS.dbPath.schema,
    port: FIELDS.port.schema,
    trustedProxies: FIELDS.trustedProxies.schema,
    tz: FIELDS.tz.schema.optional(),
  })
  .strict();

export type Config = z.output<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
  constructor(
    message: string,
    /** Names of the offending keys, as the user wrote them (env var name or config.local.json key). */
    readonly keys: string[],
  ) {
    super(message);
  }
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Path of the local JSON config; defaults to `$CONFIG_LOCAL_PATH` or `./config.local.json`. */
  configLocalPath?: string;
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the `config.local.json` that was read, if any. */
  configLocalPath: string | undefined;
}

function readConfigLocal(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Invalid configuration: ${path} is not valid JSON (${(err as Error).message})`, [
      path,
    ]);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`Invalid configuration: ${path} must contain a JSON object`, [path]);
  }
  return parsed as Record<string, unknown>;
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value));
}

/** Loads and validates the configuration. Throws `ConfigError` naming every offending key. */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const localPath = resolve(options.configLocalPath ?? env['CONFIG_LOCAL_PATH'] ?? DEFAULT_CONFIG_LOCAL_PATH);
  const local = readConfigLocal(localPath);
  const localName = options.configLocalPath ?? env['CONFIG_LOCAL_PATH'] ?? DEFAULT_CONFIG_LOCAL_PATH;

  const problems: string[] = [];
  const badKeys: string[] = [];
  const out: Record<string, unknown> = {};

  if (local) {
    for (const key of Object.keys(local)) {
      if (!(key in FIELDS)) {
        problems.push(`${key} (${localName}) is not a known setting`);
        badKeys.push(key);
      }
    }
  }

  for (const [name, field] of Object.entries(FIELDS) as [FieldName, Fields[FieldName]][]) {
    const envName = field.env;
    const envValue = envName !== undefined ? env[envName] : undefined;
    let raw: unknown;
    let source: string;
    if (envName !== undefined && envValue !== undefined && envValue !== '') {
      raw = envValue;
      source = envName;
    } else if (local && local[name] !== undefined && local[name] !== null && local[name] !== '') {
      raw = local[name];
      source = `${name} (${localName})`;
    } else {
      if (field.default !== undefined) raw = field.default;
      else continue;
      source = `${envName ?? name} (default)`;
    }
    const result = (field.schema as z.ZodType).safeParse(raw);
    if (result.success) {
      out[name] = result.data;
    } else {
      const reason = result.error.issues.map((i) => i.message).join('; ');
      problems.push(`${source} ${reason}, got ${describe(raw)}`);
      badKeys.push(source.split(' ')[0] ?? source);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`, badKeys);
  }

  return { config: ConfigSchema.parse(out), configLocalPath: local ? localPath : undefined };
}

/** Which Kalshi credential pieces are missing (empty when fully configured). */
export function missingKalshiCredentials(config: Config): string[] {
  const missing: string[] = [];
  if (config.kalshiKeyId === undefined) missing.push('KALSHI_KEY_ID');
  if (config.kalshiPrivateKeyFd === undefined && config.kalshiPrivateKeyPath === undefined) {
    missing.push('KALSHI_PRIVATE_KEY_FD or kalshiPrivateKeyPath');
  }
  return missing;
}

/**
 * Reads the Kalshi private key (PEM) once, from the file descriptor handed over by `run.sh`
 * (closed afterwards) or from the local PEM path. Returns `undefined` when no key is configured
 * or the source is empty. The key is kept in memory only and must never be logged.
 */
export function readPrivateKey(config: Config): string | undefined {
  let pem: string;
  if (config.kalshiPrivateKeyFd !== undefined) {
    const fd = config.kalshiPrivateKeyFd;
    try {
      pem = readFileSync(fd, 'utf8');
    } catch (err) {
      throw new ConfigError(
        `Invalid configuration: KALSHI_PRIVATE_KEY_FD ${fd} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
        ['KALSHI_PRIVATE_KEY_FD'],
      );
    } finally {
      try {
        closeSync(fd);
      } catch {
        // already closed or never opened
      }
    }
  } else if (config.kalshiPrivateKeyPath !== undefined) {
    try {
      pem = readFileSync(config.kalshiPrivateKeyPath, 'utf8');
    } catch (err) {
      throw new ConfigError(
        `Invalid configuration: kalshiPrivateKeyPath cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
        ['kalshiPrivateKeyPath'],
      );
    }
  } else {
    return undefined;
  }
  if (pem.trim() === '') return undefined;
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    const key = config.kalshiPrivateKeyFd !== undefined ? 'KALSHI_PRIVATE_KEY_FD' : 'kalshiPrivateKeyPath';
    throw new ConfigError(`Invalid configuration: ${key} does not contain a PEM private key`, [key]);
  }
  return pem;
}
