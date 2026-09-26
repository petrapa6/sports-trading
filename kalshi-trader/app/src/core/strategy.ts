import { z } from 'zod';

/**
 * Strategy JSON (SPEC.md §5): Zod schemas shared by the API (validation of every create / edit), the
 * engine (the stored JSON of the current version) and the web editor (inline validation with the same
 * messages). Pure: imports nothing but Zod, so the React app can bundle it.
 *
 * Amounts in the JSON are the user's numbers (`maxPrice: 0.97`, `minStakeUsd: 1`); they are limited to the
 * precision the integer units can hold exactly (prices 4 decimals = `_bp`, dollars 2 decimals, percent 2
 * decimals), so later conversion to integers (`strategyPriceBp`) never rounds.
 */

export const SPORTS = ['soccer', 'hockey'] as const;
export type StrategySport = (typeof SPORTS)[number];
export const LEADER_SIDES = ['any', 'home', 'away'] as const;
export type LeaderSide = (typeof LEADER_SIDES)[number];
export const STRATEGY_MODES = ['dry_run', 'live'] as const;
export type StrategyMode = (typeof STRATEGY_MODES)[number];

/** Latest `rule.version` of `lead_at_time`. */
export const LEAD_AT_TIME_VERSION = 1;
/** `atMinute` upper bound: soccer match minute 1–90, hockey elapsed minute 1–59 (§5). */
export const MAX_AT_MINUTE: Record<StrategySport, number> = { soccer: 90, hockey: 59 };
/** Default entry window (§5 table). */
export const DEFAULT_WINDOW_MINUTES: Record<StrategySport, number> = { soccer: 5, hockey: 3 };

/** A non-negative number with at most `decimals` decimal places in its shortest decimal form. */
const decimal = (decimals: number, what: string) =>
  z
    .number()
    .finite()
    .refine((n) => new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(String(n)), {
      message: `${what} must be a non-negative number with at most ${decimals} decimal places`,
    });

const price = (what: string) =>
  decimal(4, what)
    .refine((n) => n > 0, `${what} must be more than $0`)
    .refine((n) => n < 1, `${what} must be less than $1`);

export const LeadAtTimeRuleSchema = z
  .object({
    type: z.literal('lead_at_time'),
    version: z.literal(LEAD_AT_TIME_VERSION).default(LEAD_AT_TIME_VERSION),
    minLead: z.number().int('minLead must be a whole number').min(1, 'minLead must be at least 1').max(20),
    atMinute: z.number().int('atMinute must be a whole minute').min(1, 'atMinute must be at least 1').max(90),
    /** Defaults per sport (soccer 5, hockey 3) when omitted. */
    windowMinutes: z.number().int('windowMinutes must be a whole number').min(0).max(90).optional(),
    leaderSide: z.enum(LEADER_SIDES).default('any'),
  })
  .strict();

export const SizingSchema = z
  .object({
    type: z.literal('percent_of_balance').default('percent_of_balance'),
    percent: decimal(2, 'percent')
      .refine((n) => n > 0, 'percent must be more than 0')
      .refine((n) => n <= 100, 'percent must be at most 100'),
    minStakeUsd: decimal(2, 'minStakeUsd').refine((n) => n <= 1_000_000, 'minStakeUsd is too large'),
    maxStakeUsd: decimal(2, 'maxStakeUsd')
      .refine((n) => n > 0, 'maxStakeUsd must be more than $0')
      .refine((n) => n <= 1_000_000, 'maxStakeUsd is too large'),
  })
  .strict()
  .refine((s) => s.minStakeUsd <= s.maxStakeUsd, {
    message: 'minStakeUsd must not exceed maxStakeUsd',
    path: ['minStakeUsd'],
  });

export const ExecutionSchema = z
  .object({
    orderType: z.literal('ioc_limit').default('ioc_limit'),
    maxPrice: price('maxPrice'),
    minPrice: price('minPrice').nullable().default(null),
    maxSlippage: decimal(4, 'maxSlippage')
      .refine((n) => n <= 0.5, 'maxSlippage must be at most $0.50')
      .default(0.01),
    minDepthContracts: z
      .number()
      .int('minDepthContracts must be a whole number')
      .min(0)
      .max(1_000_000)
      .default(20),
    maxFeedAgeSec: z.number().int('maxFeedAgeSec must be a whole number').min(1).max(600).default(15),
  })
  .strict()
  .refine((e) => e.minPrice === null || e.minPrice < e.maxPrice, {
    message: 'minPrice must be below maxPrice',
    path: ['minPrice'],
  });

const LeagueIdsSchema = z
  .array(z.string().min(1).max(40))
  .min(1, 'choose at least one league')
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'leagueIds must not repeat a league');

const definitionShape = {
  name: z.string().trim().min(1, 'name is required').max(80),
  sport: z.enum(SPORTS),
  leagueIds: LeagueIdsSchema,
  rule: LeadAtTimeRuleSchema,
  sizing: SizingSchema,
  execution: ExecutionSchema,
};

type RawDefinition = z.output<z.ZodObject<typeof definitionShape>>;

/** Sport-dependent checks (the minute range of `atMinute`). */
function checkSport(d: Pick<RawDefinition, 'sport' | 'rule'>, ctx: z.RefinementCtx): void {
  const max = MAX_AT_MINUTE[d.sport];
  if (d.rule.atMinute > max) {
    ctx.addIssue({
      code: 'custom',
      path: ['rule', 'atMinute'],
      message:
        d.sport === 'soccer'
          ? 'atMinute must be a match minute from 1 to 90 (stoppage counts as 90)'
          : 'atMinute must be an elapsed minute from 1 to 59',
    });
  }
}

/** Fills the sport default of `windowMinutes`. */
function normalise<T extends Pick<RawDefinition, 'sport' | 'rule'>>(d: T) {
  return {
    ...d,
    rule: { ...d.rule, windowMinutes: d.rule.windowMinutes ?? DEFAULT_WINDOW_MINUTES[d.sport] },
  };
}

/** The versioned part of a strategy plus its name and sport: the body of an edit. */
export const StrategyDefinitionSchema = z
  .object(definitionShape)
  .strict()
  .superRefine(checkSport)
  .transform(normalise);

/**
 * The body of a create. `mode` and `killSwitch` may be given as in the §5 JSON, but only with the values
 * every new strategy starts with (kill switch on, dry run).
 */
export const StrategyCreateSchema = z
  .object({
    ...definitionShape,
    mode: z.literal('dry_run', { message: 'new strategies start in dry run' }).optional(),
    killSwitch: z.literal(true, { message: 'new strategies start with the kill switch on' }).optional(),
  })
  .strict()
  .superRefine(checkSport)
  .transform(({ mode: _mode, killSwitch: _killSwitch, ...d }) => normalise(d));

export type StrategyDefinition = z.output<typeof StrategyDefinitionSchema>;
export type StrategyDefinitionInput = z.input<typeof StrategyDefinitionSchema>;
export type LeadAtTimeRule = StrategyDefinition['rule'];
export type Sizing = StrategyDefinition['sizing'];
export type Execution = StrategyDefinition['execution'];

/** The JSON stored in one `strategy_versions` row (league ids, rule, sizing, execution). */
export interface VersionPayload {
  leagueIds: string[];
  rule: LeadAtTimeRule;
  sizing: Sizing;
  execution: Execution;
}

export const StoredRuleSchema = LeadAtTimeRuleSchema.required({ windowMinutes: true });

/** Parses the JSON columns of a `strategy_versions` row (validated again: the DB is not trusted blindly). */
export function parseVersionPayload(row: {
  league_ids: string;
  rule: string;
  sizing: string;
  execution: string;
}): VersionPayload {
  return {
    leagueIds: LeagueIdsSchema.parse(JSON.parse(row.league_ids)),
    rule: StoredRuleSchema.parse(JSON.parse(row.rule)),
    sizing: SizingSchema.parse(JSON.parse(row.sizing)),
    execution: ExecutionSchema.parse(JSON.parse(row.execution)),
  };
}

/** Whether two definitions differ in anything versioned (leagues, rule, sizing, execution). */
export function versionedPartsDiffer(a: VersionPayload, b: VersionPayload): boolean {
  const key = (v: VersionPayload) =>
    JSON.stringify([v.leagueIds, v.rule, v.sizing, v.execution], (_k, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)))
        : value,
    );
  return key(a) !== key(b);
}

/** A strategy price (dollars, ≤ 4 decimals, validated above) in integer `_bp` units, without floating point. */
export function strategyPriceBp(dollars: number): number {
  const [whole = '0', frac = ''] = String(dollars).split('.');
  return Number.parseInt(whole, 10) * 10_000 + Number.parseInt(frac.padEnd(4, '0').slice(0, 4), 10);
}

/** Issues as `path: message` lines, e.g. `sizing.percent: percent must be at most 100`. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`);
}
