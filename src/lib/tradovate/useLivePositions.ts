'use client';

/**
 * The live-position poll, as a hook (REF-108 Stage 2).
 *
 * Everything decidable without a browser lives in ./liveClock.ts and is
 * asserted there. What is left here is the part that genuinely needs one: a
 * timer, a visibility listener and a piece of state.
 *
 * THREE CONSUMERS SHARE ONE REQUEST — the day panel, the dashboard row and
 * every portfolio card on /accounts. That is `shareLivePull`'s job, not this
 * file's; mounting this hook five times costs one poll because all five
 * callers receive the same promise, and the route holds the answer for ten
 * seconds underneath that.
 *
 * Seeded from `lastLivePull` on mount rather than from nothing, so a
 * navigation between two pages that both use this does not blank the line for
 * a poll's worth of time. The seed is per user, so it cannot show one
 * trader's positions to the next.
 */

import { useEffect, useState } from 'react';

import type { BrokerLivePull } from '@/app/api/tradovate/live/route';
import {
  fetchLivePositions,
  lastLivePull,
  nextPollMs,
  shareLivePull,
  shouldKeepPolling,
} from './liveClock';

export interface LivePositionsState {
  pull: BrokerLivePull | null;
  /** True until the first answer for this user lands. */
  loading: boolean;
}

/**
 * Poll for what the trader is holding.
 *
 * `enabled` is the caller's gate and should be false when there is no broker
 * connection to ask about. It is not a performance switch: a trader outside
 * the allowlist gets `reflect_only`, and {@link shouldKeepPolling} then stops
 * the timer for the rest of the session — but not asking at all is cheaper
 * still, and the pages already know.
 */
export function useLivePositions({ userId, enabled }: {
  userId: string;
  enabled: boolean;
}): LivePositionsState {
  // SEEDED IN THE INITIALISER, not from an effect. A navigation between two
  // pages that both mount this would otherwise blank the line for a poll's
  // worth of time, and `setState` inside an effect is what the React Compiler
  // lint refuses — correctly, since this value is available during render.
  //
  // The answer carries WHOSE it is, so the two states that must never be
  // confused — "no answer yet" and "the previous trader's answer" — are the
  // same state here: the guard below resolves both to null.
  const [answer, setAnswer] = useState<{ userId: string; pull: BrokerLivePull } | null>(() => {
    const seed = lastLivePull(userId);
    return seed ? { userId, pull: seed } : null;
  });

  // Derived rather than stored, which is what lets `enabled` flip without an
  // effect writing state: a disabled hook has no answer by definition.
  const pull = enabled && answer?.userId === userId ? answer.pull : null;
  const loading = enabled && pull === null;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const visible = () =>
      typeof document === 'undefined' || document.visibilityState === 'visible';

    async function poll() {
      // A tab that went to the background between the timer being set and it
      // firing. Nothing is requested; `onVisible` restarts the loop.
      if (!visible()) {
        clear();
        return;
      }

      const next = await shareLivePull(userId, Date.now, () => fetchLivePositions());
      if (cancelled) return;

      setAnswer({ userId, pull: next });

      // `reflect_only` ends the loop for this mount: no amount of polling
      // turns a trader with no broker view into one with positions.
      if (!shouldKeepPolling(next)) {
        clear();
        return;
      }

      clear();
      timer = setTimeout(poll, nextPollMs(next));
    }

    function onVisible() {
      if (!visible() || cancelled) {
        // Hidden: stop the timer rather than let it fire into a background
        // tab. A trader who is not looking should cost nothing.
        clear();
        return;
      }
      // Showing fires IMMEDIATELY rather than waiting out the interval — a
      // trader who just switched to this tab is asking.
      clear();
      void poll();
    }

    void poll();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clear();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, enabled]);

  return { pull, loading };
}

/**
 * The open positions, flattened for rendering, or an empty list.
 *
 * Here rather than in each consumer because all three render the same lines
 * and a second flattening would be a second chance to disagree about what
 * counts as open. An account with no positions is dropped: the route already
 * excludes `netPos === 0`, so an empty list means the account is flat and
 * there is nothing to say about it.
 */
export function openAccounts(pull: BrokerLivePull | null) {
  if (pull === null || pull.source !== 'broker_verified') return [];
  return pull.accounts.filter((account) => account.positions.length > 0);
}
