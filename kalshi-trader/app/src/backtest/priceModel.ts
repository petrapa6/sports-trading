import { z } from 'zod';
import type { Sport } from '../feeds/gameState.js';
import { LAST_MINUTE } from './clock.js';

/**
 * The backtester's modelled price (SPEC.md §9 Price providers): the median YES ask close by (sport, lead
 * bucket 1 / 2 / 3+, remaining-minute bucket of 5), stored in `settings.price_model` by the builder (T11).
 * A cell with fewer than `MIN_SAMPLE` observations — or no stored model at all — falls back to the
 * conservative seed table below, and every lookup reports the sample size behind it.
 */

export const MIN_SAMPLE = 20;
export const REMAINING_BUCKET_MIN = 5;
export const MAX_LEAD_BUCKET = 3;

export const PriceModelCellSchema = z.object({
  sport: z.enum(['soccer', 'hockey']),
  /** 1, 2 or 3 (= 3 or more). */
  lead: z.number().int().min(1).max(MAX_LEAD_BUCKET),
  /** Start of the remaining-minute bucket: 0, 5, 10, … (`10` = 10–14 minutes left). */
  remaining: z.number().int().min(0),
  askBp: z.number().int().min(1).max(9999),
  sampleSize: z.number().int().min(0),
});
export type PriceModelCell = z.output<typeof PriceModelCellSchema>;

export const PriceModelSchema = z.object({
  builtAt: z.string().optional(),
  cells: z.array(PriceModelCellSchema),
});
export type PriceModel = z.output<typeof PriceModelSchema>;

/** The stored model, or `null` when there is none or it does not parse (the seed table is used then). */
export function parsePriceModel(value: unknown): PriceModel | null {
  const r = PriceModelSchema.safeParse(value);
  return r.success ? r.data : null;
}

export const leadBucket = (lead: number): number => Math.min(Math.max(lead, 1), MAX_LEAD_BUCKET);
export const remainingBucket = (minutesRemaining: number): number =>
  Math.floor(Math.max(0, minutesRemaining) / REMAINING_BUCKET_MIN) * REMAINING_BUCKET_MIN;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Seed ask (price units) for a cell. Anchored on the §9 values — soccer lead 2 with 10 minutes left $0.96,
 * lead 1 with 10 left $0.85, hockey lead 2 with 5 left $0.97 — and moving by a fixed step per 5-minute
 * bucket: soccer lead 1 3¢, lead 2 1¢; hockey lead 1 4¢, lead 2 1.5¢; lead 3+ is lead 2 plus 2.5¢ (soccer)
 * or 1.5¢ (hockey). Capped at $0.99.
 */
export function seedAskBp(sport: Sport, lead: number, remaining: number): number {
  const l = leadBucket(lead);
  const r = remainingBucket(remaining);
  if (sport === 'soccer') {
    const steps = (r - 10) / REMAINING_BUCKET_MIN;
    const lead2 = clamp(9600 - steps * 100, 7500, 9900);
    if (l === 1) return clamp(8500 - steps * 300, 5000, 9900);
    if (l === 2) return lead2;
    return clamp(lead2 + 250, 7500, 9900);
  }
  const steps = (r - 5) / REMAINING_BUCKET_MIN;
  const lead2 = clamp(9700 - steps * 150, 7500, 9900);
  if (l === 1) return clamp(8800 - steps * 400, 5000, 9900);
  if (l === 2) return lead2;
  return clamp(lead2 + 150, 7500, 9900);
}

/** Every seed cell of both sports (what an empty database yields). */
export function seedTable(): PriceModelCell[] {
  const cells: PriceModelCell[] = [];
  for (const sport of ['soccer', 'hockey'] as const) {
    for (let lead = 1; lead <= MAX_LEAD_BUCKET; lead++) {
      for (let remaining = 0; remaining < LAST_MINUTE[sport]; remaining += REMAINING_BUCKET_MIN) {
        cells.push({ sport, lead, remaining, askBp: seedAskBp(sport, lead, remaining), sampleSize: 0 });
      }
    }
  }
  return cells;
}

export interface ModelPrice {
  askBp: number;
  /** Observations behind the cell (0 when the model has no such cell). */
  sampleSize: number;
  /** The seed value was used (fewer than `MIN_SAMPLE` observations). */
  seeded: boolean;
}

/** An indexed model for fast lookups during a simulation. */
export class PriceModelLookup {
  private readonly cells = new Map<string, PriceModelCell>();

  constructor(model: PriceModel | null) {
    for (const c of model?.cells ?? []) this.cells.set(`${c.sport}|${c.lead}|${c.remaining}`, c);
  }

  /** `priceModel(sport, lead, minutesRemaining)` of §9. */
  price(sport: Sport, lead: number, minutesRemaining: number): ModelPrice {
    const l = leadBucket(lead);
    const r = remainingBucket(minutesRemaining);
    const cell = this.cells.get(`${sport}|${l}|${r}`);
    if (cell && cell.sampleSize >= MIN_SAMPLE) {
      return { askBp: cell.askBp, sampleSize: cell.sampleSize, seeded: false };
    }
    return { askBp: seedAskBp(sport, l, r), sampleSize: cell?.sampleSize ?? 0, seeded: true };
  }
}
