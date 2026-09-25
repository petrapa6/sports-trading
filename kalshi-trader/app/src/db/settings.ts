import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Orm } from './connection.js';
import { settings } from './schema.js';

const micros = z.number().int().refine(Number.isSafeInteger, 'must be a safe integer');
const nonNegativeMicros = micros.refine((n) => n >= 0, 'must not be negative');

/**
 * Every `settings` key (SPEC.md §7) with its value schema and the default returned while the
 * key has no row. Values are stored as JSON text.
 */
export const SETTINGS = {
  global_kill_switch: { schema: z.boolean(), default: false },
  global_dry_run: { schema: z.boolean(), default: true },
  dry_run_bankroll_micros: { schema: micros, default: 100_000_000 },
  dry_run_initial_bankroll_micros: { schema: nonNegativeMicros, default: 100_000_000 },
  fee_balance_precision_micros: {
    schema: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .refine((n) => 1_000_000 % n === 0, 'must divide $1'),
    default: 100,
  },
  kalshi_order_group_id: { schema: z.string().min(1).nullable(), default: null },
  order_group_contract_limit: { schema: z.number().int().positive().max(1_000_000), default: 200 },
  price_model: { schema: z.json().nullable(), default: null },
  api_football_key_enc: { schema: z.string().min(1).nullable(), default: null },
  notifications: { schema: z.record(z.string(), z.json()), default: {} },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown }>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;
export type AllSettings = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export class SettingsError extends Error {
  override name = 'SettingsError';
}

function parse<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  const result = (SETTINGS[key].schema as z.ZodType).safeParse(value);
  if (!result.success) {
    throw new SettingsError(
      `setting ${key}: ${result.error.issues.map((i) => i.message).join('; ')}, got ${JSON.stringify(value)}`,
    );
  }
  return result.data as SettingValue<K>;
}

/** Typed access to the `settings` table. */
export class SettingsRepository {
  constructor(
    private readonly orm: Orm,
    private readonly now: () => number = Date.now,
  ) {}

  /** The stored value, or the key's default when no row exists. */
  get<K extends SettingKey>(key: K): SettingValue<K> {
    if (!(key in SETTINGS)) throw new SettingsError(`unknown setting ${String(key)}`);
    const row = this.orm.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return structuredClone(SETTINGS[key].default) as SettingValue<K>;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      throw new SettingsError(`setting ${key}: stored value is not valid JSON`);
    }
    return parse(key, value);
  }

  /** Validates and stores a value (upsert). */
  set<K extends SettingKey>(key: K, value: SettingValue<K>): void {
    if (!(key in SETTINGS)) throw new SettingsError(`unknown setting ${String(key)}`);
    const json = JSON.stringify(parse(key, value));
    const updated_at = new Date(this.now()).toISOString();
    this.orm
      .insert(settings)
      .values({ key, value: json, updated_at })
      .onConflictDoUpdate({ target: settings.key, set: { value: json, updated_at } })
      .run();
  }

  /** Removes the row so the key falls back to its default. */
  reset(key: SettingKey): void {
    this.orm.delete(settings).where(eq(settings.key, key)).run();
  }

  /** Every setting, defaults filled in. */
  getAll(): AllSettings {
    const out: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) out[key] = this.get(key);
    return out as AllSettings;
  }
}
