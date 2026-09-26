import type { Logger } from 'pino';
import type { BalanceRecorder } from './balances.js';
import type { TradeEvent } from './executor.js';
import type { OrderGroupManager } from './orderGroup.js';

/**
 * Start-up order of the trading loop (SPEC.md §4 invariants, T13): the order group is ensured (when live orders
 * are possible), then restart recovery resolves every `pending` attempt — live ones against Kalshi — and only
 * then do the scheduler, the settler and the balance recorder start. Failures are logged; the loop starts
 * anyway (unresolved live attempts stay `pending` and are retried by the settler loop).
 */
export async function startTrading(o: {
  log: Logger;
  orderGroups?: Pick<OrderGroupManager, 'enabled' | 'ensure'> | undefined;
  recover: () => Promise<unknown>;
  /** Started in this order once recovery has finished. */
  loops: readonly { start(): void }[];
}): Promise<void> {
  if (o.orderGroups?.enabled) {
    try {
      await o.orderGroups.ensure();
    } catch (err) {
      o.log.error({ mode: 'live', err: { message: (err as Error).message } }, 'Order group set-up failed');
    }
  }
  try {
    await o.recover();
  } catch (err) {
    o.log.error({ err: { message: (err as Error).message } }, 'Trade recovery at start-up failed');
  }
  for (const loop of o.loops) loop.start();
}

type TradeSource = { on(event: 'trade', listener: (t: TradeEvent) => void): unknown };

/** A `balance_snapshots` row shortly after every live fill and every live settlement (§7, T13). */
export function snapshotBalanceOnLiveChanges(
  balances: Pick<BalanceRecorder, 'recordSoon'>,
  executor: TradeSource,
  settler: TradeSource,
): void {
  executor.on('trade', (t) => {
    if (t.mode === 'live' && t.status === 'filled') balances.recordSoon('fill');
  });
  settler.on('trade', (t) => {
    if (t.mode === 'live') balances.recordSoon('settlement');
  });
}
