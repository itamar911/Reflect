'use client';

/**
 * The live-position poll and its lines, as one thing to drop into a page
 * (REF-108 Stage 3).
 *
 * Three consumers mount this — the trade form's day panel, the dashboard
 * greeting row and every portfolio card — and mounting it five times costs
 * ONE request: `shareLivePull` hands every caller the same promise and the
 * route holds the answer for ten seconds underneath that. So each consumer
 * asks for what it needs rather than having positions threaded down to it
 * through props it would otherwise not have.
 *
 * `enabled` should be the server-side gate — the allowlist AND migration 037
 * — evaluated in a page or a layout and passed down, the same arrangement
 * `canSync` and `portfoliosEnabled` already use. The route refuses a caller
 * outside the allowlist anyway and the clock stops the loop on
 * `reflect_only`, so a wrong `false` costs the feature and a wrong `true`
 * costs exactly one request. Passing it is about not making that request for
 * every trader on every page.
 */

import { openAccounts, useLivePositions } from '@/lib/tradovate/useLivePositions';
import LivePositionLines, { type LiveLayout } from './LivePositionLines';

export default function LivePositions({
  userId,
  enabled,
  compact = false,
  accountId = null,
  layout = 'positions',
}: {
  userId: string;
  enabled: boolean;
  compact?: boolean;
  /**
   * Render only this portfolio's positions — `accounts.id`, ours.
   *
   * For the portfolio card, which is about one portfolio and would otherwise
   * repeat every other card's positions inside its own slot. Null means all
   * of them, which is what the day panel and the dashboard want.
   */
  accountId?: string | null;
  /**
   * Which shape this surface wants (REF-108 Stage 4b).
   *
   * `positions` — a line per contract, the figure on the portfolio. The day
   * panel and the portfolio card. `portfolios` — a line per portfolio with its
   * name and figure, which is the dashboard's 20.10 requirement.
   *
   * Defaulted rather than required so the two surfaces that want the original
   * shape say nothing, and the one that changed says so at its mount site.
   */
  layout?: LiveLayout;
}) {
  const { pull } = useLivePositions({ userId, enabled });
  const accounts = openAccounts(pull);
  const scoped = accountId === null ? accounts : accounts.filter((a) => a.accountId === accountId);

  return <LivePositionLines accounts={scoped} compact={compact} layout={layout} />;
}
