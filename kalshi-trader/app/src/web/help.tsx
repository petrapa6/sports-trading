import type { ReactNode } from 'react';

/**
 * The explanations behind the ⓘ buttons that more than one page shows (strategy parameters, metrics, skip
 * reasons, modes), so the Strategies editor, the Backtest form and the tables say the same thing.
 */

// ---- strategy parameters ----------------------------------------------------------------------------------

export const RULE_HELP = {
  rule: (
    <>
      <p>
        <strong>Lead at time</strong>: buy YES on the leading team when it leads by at least the minimum lead
        at any moment from <em>From minute</em> to <em>From minute + Window</em>.
      </p>
      <p>Never during a break (half-time, intermission) and never while the score feeds disagree.</p>
    </>
  ),
  minLead: 'Goals the leading team must be ahead by (e.g. 2 = a lead of two goals or more).',
  atMinute: (sport: 'soccer' | 'hockey') =>
    sport === 'soccer'
      ? 'First match minute (1–90) at which the rule may fire. Stoppage time counts as minute 45 / 90.'
      : 'First elapsed game minute (1–59) at which the rule may fire. Overtime is excluded.',
  windowMinutes:
    'How many minutes after "From minute" the entry stays open. If no fill happens by then, the trade ends skipped with its last reason. 0 = only during the starting minute.',
  leaderSide: 'Which team may be the leader: either team, only the home team or only the away team.',
  maxOpponentGoals:
    'Optional. Fire only if the trailing team has scored at most this many goals (0 = the leader keeps a clean sheet). Empty = no limit.',
  underdogOnly:
    "Fire only if the leader was the pre-game underdog: its YES ask at kick-off was below the opponent's. The app records both asks when it sees the game start (in backtests: exact prices only).",
  percent:
    'Stake per trade as a percentage of the balance (the Kalshi cash balance for live trades, the shared dry-run bankroll for dry runs, the backtest bankroll in backtests), then kept between Min stake and Max stake.',
  minStakeUsd: 'A smaller percentage stake is raised to this amount (in dollars).',
  maxStakeUsd: 'A larger percentage stake is capped at this amount (in dollars).',
  maxPrice:
    'Highest price per YES contract the strategy pays (between $0 and $1). A contract pays $1 if the team wins, so $0.97 means paying at most 97¢ to win 3¢. A higher ask leaves the trade waiting.',
  minPrice:
    'Optional. Lowest ask the strategy accepts; a cheaper ask (the market doubts the leader) leaves the trade waiting. Empty = no minimum.',
  maxSlippage:
    'How far above the current ask the limit price may go: limit = min(ask + slippage, max price). The order never fills above the limit.',
  minDepthContracts:
    'Contracts that must be offered at or below the limit price; a thinner orderbook leaves the trade waiting.',
  maxFeedAgeSec:
    'The newest score observation must be at most this many seconds old; an older one leaves the trade waiting (stale feed).',
  execution: (
    <>
      <p>
        Every entry is an <strong>immediate-or-cancel limit order</strong>: it buys what is offered at or
        below the limit price right away and cancels the rest.
      </p>
      <p>In dry run the fill is simulated at the limit price against the real orderbook.</p>
    </>
  ),
  sizing:
    'How much each trade stakes. Contracts bought = stake ÷ limit price (rounded down), capped by what the orderbook offers at or below the limit.',
} as const;

// ---- modes ----------------------------------------------------------------------------------------------

export const MODE_HELP = {
  killSwitch:
    'On = the strategy is paused and never trades. New strategies start with it on. Turning it off asks for your password.',
  mode: 'Live places real Kalshi orders with real money; Dry run only simulates them against real prices. Switching to live asks for your password.',
  effective: (
    <>
      <p>The mode the strategy actually runs in right now:</p>
      <ul>
        <li>
          <strong>PAUSED</strong>: its kill switch or the global kill switch is on.
        </li>
        <li>
          <strong>LIVE → DRY RUN (global)</strong>: set to live, but global dry run is on.
        </li>
        <li>
          <strong>LIVE → DRY RUN (add-on lock)</strong>: set to live, but <code>allow_live_orders</code> is
          off in Home Assistant.
        </li>
      </ul>
    </>
  ),
  liveVsDry:
    'Live and dry-run results are always shown separately and never added together (left = Live, right = Dry run).',
} as const;

// ---- metrics --------------------------------------------------------------------------------------------

export const METRIC_HELP: Record<string, ReactNode> = {
  trades: 'Settled trades (won, lost or void) in the filter range; below, how many trades got a fill.',
  'win-rate': 'Won ÷ (won + lost). Void settlements (a tie or a fair-price settlement) are not counted.',
  'net-pnl': 'Realized profit or loss after fees: payouts − cost − fees of settled trades.',
  roi: 'Return on investment: net P&L ÷ money invested (cost + fees of settled trades).',
  'max-drawdown': 'The largest drop from a running peak of cumulative P&L, in dollars.',
  'avg-price': 'Average fill price per contract. A price of $0.92 implies a 92 % chance of winning.',
  'avg-fee': 'Average Kalshi trading fee per filled trade.',
  'implied-vs-actual':
    'Mean price paid (the win probability the market implied) against the actual win rate. Actual above implied = the strategy has an edge.',
  'forced-dry-run':
    'Share of dry-run trades whose strategy was set to live but ran as dry run (global dry run or add-on lock).',
  bankroll: 'Backtest bankroll at the end of the run, from the initial bankroll set in the form.',
};

// ---- trade statuses and skip reasons ----------------------------------------------------------------------

export const STATUS_HELP = (
  <>
    <ul>
      <li>
        <strong>Signalled / pending</strong>: the rule matched; an attempt or a live order is in flight.
      </li>
      <li>
        <strong>Waiting</strong>: a soft guard blocked the entry (price, depth, stale feed …); it is retried
        on each score update while the window is open.
      </li>
      <li>
        <strong>Filled</strong>: bought, not settled yet.
      </li>
      <li>
        <strong>Won / Lost / Void</strong>: settled by Kalshi.
      </li>
      <li>
        <strong>Skipped</strong>: never filled; the reason says why.
      </li>
    </ul>
  </>
);

export const SKIP_REASON_HELP: Record<string, string> = {
  price: 'The ask was above the max price.',
  min_price: 'The ask was below the min price.',
  liquidity: 'Too few contracts offered at or below the limit price (min depth).',
  stale_feed: 'The newest score observation was older than the max feed age.',
  feed_blocked: 'The score feeds disagreed, so entries were blocked.',
  exchange_paused: 'Kalshi had trading paused.',
  market_closed: 'The Kalshi market was already closed.',
  too_small: 'The stake could not buy a single contract.',
  paused: 'A kill switch was on at the time of the attempt.',
  error: 'A request to Kalshi failed; retried while the window was open.',
  unfilled: 'The order was sent but nothing was offered at the limit price.',
  order_group_limit: 'The order group contract limit was hit (Settings → Trading).',
  order_rejected: 'Kalshi rejected the live order.',
  mode_changed: 'The effective mode left live between the checks and the order.',
  no_market: 'No Kalshi market was found for the leading team.',
  restart: 'The app restarted while a dry-run attempt was in flight.',
  restart_no_order: 'The app restarted and Kalshi had no record of the pending live order.',
  order_not_found: 'Kalshi had no record of the pending live order.',
  window_expired: 'The entry window closed before a fill.',
};

/** The skip reasons as a list (for a tooltip next to a reason filter or a skips summary). */
export const SKIP_REASONS_HELP = (
  <ul>
    {Object.entries(SKIP_REASON_HELP).map(([k, v]) => (
      <li key={k}>
        <strong>{k.replaceAll('_', ' ')}</strong>: {v}
      </li>
    ))}
  </ul>
);
