# `stats-seed.sql` — the T10 stats fixture

`stats-seed.sql` loads into a migrated database (the leagues come from migration `0001`): two soccer strategies
**A** ("Stats A") and **B** ("Stats B"), both on `epl` + `laliga` with `maxPrice` 0.97, and 30 trades in both
modes, plus 15 `trade_attempts`, 8 `bankroll_snapshots` and 6 `balance_snapshots`. `stats-seed.expected.json`
holds the `GET /api/stats` response for six queries with the clock at `2026-09-20T12:00:00.000Z` and the app on
Kalshi `demo` (`test/unit/stats/stats.test.ts` compares them field by field).

Units: money in micro-dollars, prices in $0.0001 (`bp`), counts in centi-contracts (`cc`). `cost = cc × bp`,
`payout = cc × settlement_bp`, `P&L = payout − cost − fee`. Ratios are rounded to 4 decimals, averages to whole
units, half away from zero.

## The trades

Triggered in September 2026 (`range=7d` starts at `09-13 12:00`, so #16–#30 are the "recent half").

| #   | Strat | League | Mode (configured)                  | Status                       | Trig.    | Min | cc  | bp   | Fee    | Settled      | P&L           |
| --- | ----- | ------ | ---------------------------------- | ---------------------------- | -------- | --- | --- | ---- | ------ | ------------ | ------------- |
| 1   | A     | epl    | live                               | won                          | 01 15:00 | 60  | 200 | 9400 | 7 900  | 01 17:00     | 112 100       |
| 2   | A     | epl    | live                               | lost                         | 02 15:00 | 62  | 100 | 9500 | 4 000  | **05 18:00** | −954 000      |
| 3   | A     | laliga | live                               | won                          | 03 15:00 | 70  | 300 | 9300 | 11 000 | 03 17:00     | 199 000       |
| 4   | B     | epl    | live                               | won                          | 04 15:00 | 75  | 100 | 9600 | 3 000  | 04 17:00     | 37 000        |
| 5   | B     | laliga | live                               | skipped `price` (window)     | 05 15:00 | 75  |     |      |        |              |               |
| 6   | A     | epl    | dry run                            | won                          | 01 15:05 | 60  | 200 | 9400 | 7 900  | 01 17:00     | 112 100       |
| 7   | A     | epl    | dry run                            | won                          | 02 15:00 | 65  | 100 | 9200 | 5 200  | 02 17:00     | 74 800        |
| 8   | A     | laliga | dry run                            | lost                         | 03 15:00 | 70  | 200 | 9500 | 7 000  | 03 17:05     | −1 907 000    |
| 9   | B     | epl    | dry run (**live**, add-on lock)    | won                          | 04 15:00 | 80  | 100 | 9700 | 2 000  | 04 17:00     | 28 000        |
| 10  | B     | laliga | dry run                            | **void** (0.50)              | 05 15:00 | 80  | 200 | 9000 | 13 000 | 05 17:00     | −813 000      |
| 11  | B     | epl    | dry run                            | skipped `too_small`          | 06 15:00 | 75  |     |      |        |              |               |
| 12  | A     | epl    | dry run                            | skipped `liquidity` (window) | 07 15:00 | 60  |     |      |        |              |               |
| 13  | B     | laliga | live                               | won                          | 08 15:00 | 78  | 100 | 9100 | 6 000  | 08 17:00     | 84 000        |
| 14  | A     | laliga | dry run                            | won                          | 09 15:00 | 66¹ | 100 | 9300 | 4 000  | 09 17:00     | 66 000        |
| 15  | B     | epl    | live, **env prod**                 | won                          | 10 15:00 | 70  | 100 | 9400 | 4 000  | 10 17:00     | (not in demo) |
| 16  | A     | epl    | live                               | won                          | 14 15:00 | 60  | 200 | 9500 | 7 000  | 14 17:00     | 93 000        |
| 17  | A     | epl    | live                               | won                          | 15 14:00 | 61  | 100 | 9400 | 4 000  | 15 16:00     | 56 000        |
| 18  | A     | laliga | live                               | lost                         | 15 15:00 | 70  | 100 | 9200 | 5 200  | 15 17:00     | −925 200      |
| 19  | B     | epl    | live                               | filled (open)                | 16 15:00 | 75  | 100 | 9500 | 3 000  |              |               |
| 20  | B     | laliga | live                               | waiting `price`              | 19 15:00 | 75  |     |      |        |              |               |
| 21  | A     | epl    | dry run                            | won                          | 14 15:00 | 60  | 300 | 9400 | 12 000 | 14 17:00     | 168 000       |
| 22  | A     | epl    | dry run (**live**, global dry run) | lost                         | 15 15:00 | 62  | 100 | 9600 | 3 000  | 15 17:00     | −963 000      |
| 23  | A     | laliga | dry run                            | won                          | 16 15:00 | 70  | 100 | 9500 | 3 000  | 16 17:00     | 47 000        |
| 24  | B     | epl    | dry run                            | won                          | 16 15:30 | 76  | 200 | 9300 | 9 000  | 16 17:30     | 131 000       |
| 25  | B     | laliga | dry run                            | won                          | 17 15:00 | 80  | 100 | 9400 | 4 000  | 17 17:00     | 56 000        |
| 26  | B     | epl    | dry run                            | filled (open)                | 18 15:00 | 77  | 100 | 9500 | 3 000  |              |               |
| 27  | A     | laliga | dry run                            | skipped `price` (window)     | 18 15:00 | 70  |     |      |        |              |               |
| 28  | B     | epl    | dry run                            | skipped `market_closed`      | 18 16:00 | 75  |     |      |        |              |               |
| 29  | A     | epl    | live                               | skipped `liquidity`          | 19 15:00 | 60  |     |      |        |              |               |
| 30  | B     | laliga | dry run                            | waiting `stale_feed`         | 19 16:00 | 80  |     |      |        |              |               |

¹ #14's snapshot has no top-level `minute`, only `clock.minute` (checks the fallback). #2 settles _after_ #3
and #4 although triggered before them (checks that the equity curve follows `settled_at`).

Attempts that did not fill (per-attempt skips): #5 price ×2, #16 price, #20 price, #29 liquidity (live);
#11 too_small, #12 liquidity, #22 error, #27 price ×2, #28 market_closed, #30 stale_feed (dry run).

## Worked example: unfiltered (`demo`, all dates)

**Live** (#1–5, 13, 16–20, 29; #15 is `prod`): settled #1, 2, 3, 4, 13, 16, 17, 18 → trades 8, won 6, lost 2,
void 0, win rate 6 / 8 = **0.75**.
Net P&L = 112 100 − 954 000 + 199 000 + 37 000 + 84 000 + 93 000 + 56 000 − 925 200 = **−1 298 100**.
Invested = 1 887 900 + 954 000 + 2 801 000 + 963 000 + 916 000 + 1 907 000 + 944 000 + 925 200 = 11 298 100;
ROI = −1 298 100 / 11 298 100 = −0.11489 → **−0.1149**.
Equity by settlement: #1 112 100, #3 311 100, #4 348 100 (peak), #2 −605 900, #13 −521 900, #16 −428 900,
#17 −372 900, #18 −1 298 100 → max drawdown 348 100 + 1 298 100 = **1 646 200**.
Fills (settled + #19) = 9: prices 84 500 / 9 = 9388.9 → **9389**; fees 51 100 / 9 = 5677.8 → **5678**.
Implied: won + lost prices 75 000 / 8 = **9375** against 0.75.

**Dry run** (17 trades): settled #6, 7, 8, 9, 10, 14, 21–25 → trades 11, won 8, lost 2, void 1, win rate
8 / 10 = **0.8** (void excluded).
Net P&L = 682 900 − 3 683 000 = **−3 000 100**; invested 16 000 100; ROI = −0.187505 → **−0.1875**.
Equity: #6 112 100, #7 186 900 (peak), #8 −1 720 100, #9 −1 692 100, #10 −2 505 100, #14 −2 439 100,
#21 −2 271 100, #22 −3 234 100 (trough), #23 −3 187 100, #24 −3 056 100, #25 −3 000 100 → max drawdown
186 900 + 3 234 100 = **3 421 000**.
Fills = 12: prices 112 800 / 12 = **9400**; fees 73 100 / 12 = 6091.7 → **6092**.
Implied: (112 800 − 9000 − 9500) / 10 = **9430** against 0.8. Forced dry run: #9, #22 of 17 → **0.1176**.

## Worked example: `range=7d` (triggered from 09-13 12:00: #16–#30)

**Live**: settled #16, 17, 18 → 3, win rate 2 / 3 = 0.6667; P&L 93 000 + 56 000 − 925 200 = −776 200; invested
3 776 200 → ROI −0.2056; equity 93 000, 149 000 (peak), −776 200 → max drawdown 925 200; fills #16–19: avg price
37 600 / 4 = 9400, avg fee 19 200 / 4 = 4800; implied 28 100 / 3 = 9367. Balance line: 2 points (09-15, 09-19).

**Dry run**: settled #21–25 → 5, win rate 4 / 5 = 0.8; P&L −561 000; invested 7 561 000 → ROI −0.0742; equity
168 000 (peak), −795 000, −748 000, −617 000, −561 000 → max drawdown 963 000; fills #21–26: avg price
56 700 / 6 = 9450, avg fee 34 000 / 6 = 5666.7 → 5667; implied 47 200 / 5 = 9440; forced 1 of 9 = 0.1111.
Bankroll line: 4 points (09-14 15:00 … 09-18 15:00).

## Tiles of the other cases

| Case           | Mode    | Trades                          | Win rate | Net P&L    | ROI     | Max DD    | Avg price | Avg fee | Implied (n) | Forced |
| -------------- | ------- | ------------------------------- | -------- | ---------- | ------- | --------- | --------- | ------- | ----------- | ------ |
| `strategies=A` | live    | 6                               | 0.6667   | −1 419 100 | −0.1507 | 1 730 200 | 9383      | 6517    | 9383 (6)    |        |
| `strategies=A` | dry run | 7                               | 0.7143   | −2 402 100 | −0.2309 | 2 636 000 | 9414      | 6014    | 9414 (7)    | 1 / 9  |
| `leagues=epl`  | live    | 5                               | 0.8      | −655 900   | −0.0985 | 954 000   | 9483      | 4817    | 9480 (5)    |        |
| `leagues=epl`  | dry run | 6                               | 0.8333   | −449 100   | −0.0475 | 963 000   | 9443      | 6014    | 9433 (6)    | 2 / 10 |
| `mode=live`    | live    | as unfiltered; no `dry_run` key |          |            |         |           |           |         |             |        |
| `mode=dry_run` | dry run | as unfiltered; no `live` key    |          |            |         |           |           |         |             |        |

The series in `stats-seed.expected.json` (equity points, daily P&L per strategy, histogram bins 8200–9700,
trades per minute by outcome, skip reasons, bankroll / balance points) follow from the table above with the same
rules; they were produced by an independent reference computation (plain loops over this table, not the app's
SQL) and spot-checked against the worked examples.
