import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname });

async function restrictedSyntaxCount(code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: 'src/core/example.ts' });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe('lint rule: no floating point on *_dollars / *_fp fields', () => {
  it.each([
    'export const a = (m: { yes_bid_dollars: string }) => parseFloat(m.yes_bid_dollars);',
    'export const a = (m: { yes_bid_dollars: string }) => Number(m.yes_bid_dollars);',
    "export const a = (m: Record<string, string>) => Number(m['last_price_dollars']);",
    'export const a = (m: { count_fp: string }) => Number.parseFloat(m.count_fp);',
    'export const a = (price_dollars: string) => parseFloat(price_dollars);',
    'export const a = (m: { balance_dollars: string }) => +m.balance_dollars;',
  ])('flags %s', async (code) => {
    expect(await restrictedSyntaxCount(code)).toBeGreaterThan(0);
  });

  it.each([
    "import { dollarsToBp } from './decimal.js';\nexport const a = (m: { yes_bid_dollars: string }) => dollarsToBp(m.yes_bid_dollars);",
    'export const a = (m: { count: string }) => Number(m.count);',
  ])('allows %s', async (code) => {
    expect(await restrictedSyntaxCount(code)).toBe(0);
  });
});
