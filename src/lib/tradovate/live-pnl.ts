/**
 * Whether Reflect may show the broker's open P&L on a position (compliance
 * decision 29.10).
 *
 * ONE ENVIRONMENT VARIABLE, DEFAULT OFF, AND THE CODE IS STILL THERE.
 *
 *     TRADOVATE_LIVE_PNL_ENABLED=1
 *
 *
 * WHY THE FIGURE IS GATED RATHER THAN DELETED
 * -------------------------------------------
 *
 * REF-108 Stage 4a shipped `openPnl` off
 * `/cashBalance/getcashbalancesnapshot` — a number the BROKER computes, not
 * one we price, which is why it was defensible while Market Data stayed Denied
 * in our OAuth registration (see the header on ./positions.ts for that whole
 * argument).
 *
 * **NinjaTrader confirmed on 29.10 that the argument does not hold.**
 * Account-level open P&L falls under the same Market Data denial, and
 * redistributing it needs a CME Information License Agreement Reflect does not
 * have. So Reflect must stop showing live open P&L before public launch.
 *
 * The entitlement is the thing that is missing, not the integration. An ILA is
 * an application with an outcome, and the day it lands the figure is one
 * environment variable away from working exactly as it was measured on 19.10 —
 * so `readOpenPnl`, the field, the colour rule, the per-portfolio qualifier and
 * every assertion over them stay in the repository. Deleting them would mean
 * re-deriving `null`-is-not-`0`, the flat-account rate limit and the
 * "(סה״כ בתיק)" placement rule from scratch against a compliance deadline.
 *
 *
 * WHAT OFF MEANS, AND WHERE IT IS DECIDED
 * ---------------------------------------
 *
 * **SERVER-SIDE, IN ONE PLACE: {@link loadOpenPositions}.** Off, and the
 * snapshot POST is not issued at all — zero upstream calls, not a call whose
 * answer is discarded — and every account's `openPnl` is `null` on the wire.
 *
 * That is the whole gate, and it is deliberately NOT mirrored in the browser.
 * `null` is a state the UI has rendered since Stage 3 and renders correctly: the
 * position line without a figure, no "(סה״כ בתיק)" row, no dash, no "לא זמין"
 * and no error. A `NEXT_PUBLIC_` twin would be a second flag to keep in step
 * with this one, for a rendering decision that already follows from the data.
 *
 * **THE POSITION ITSELF IS UNAFFECTED.** `/position/list` still runs on the
 * poll, so the contract, the quantity and the side are reported exactly as
 * before — what a trader is holding is ours to say, what it is currently worth
 * is not.
 *
 * `'1'` and not any truthy string, for {@link isImportEnabled}'s reason:
 * `TRADOVATE_LIVE_PNL_ENABLED=0` and `=false` are the two things somebody types
 * when they mean OFF, and both are truthy. Here that matters more than it does
 * there — the truthy-string reading of `=0` would turn a deliberate off into a
 * compliance breach.
 */

/** The variable's name, in one place, so a suite and a doc cannot misspell it. */
export const LIVE_PNL_FLAG = 'TRADOVATE_LIVE_PNL_ENABLED';

/**
 * Whether the broker's open figure may be read and published.
 *
 * UNSET IS OFF, which is the state every deployment is in until somebody sets
 * it — see the header. `env` is a parameter for the same reason
 * `parseAllowlist`'s is: the suite asserts the parsing against objects rather
 * than by mutating the process it runs in.
 */
export function isLivePnlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_PNL_FLAG] === '1';
}
