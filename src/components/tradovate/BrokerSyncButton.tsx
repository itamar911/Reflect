'use client';

/**
 * "סנכרן עכשיו" — the button, and the automatic sync that fires on page entry
 * (REF-107 Stage 2.5).
 *
 * ONE COMPONENT FOR BOTH TRIGGERS, mounted in three places (/trades, /journal,
 * the dashboard). They are the same component rather than a button and a
 * separate effect because they must share one state machine, one throttle and
 * one in-flight promise: if they did not, the button could report "הכל מעודכן"
 * while a page-entry sync it knew nothing about was still importing four
 * trades. The shared half lives in lib/tradovate/syncClock.ts, at module
 * level, so two of these mounted at once share it too.
 *
 *
 * WHY THE AUTO TRIGGER IS HERE AND NOT IN A LAYOUT OR A PAGE
 * ----------------------------------------------------------
 *
 * Not in app/(app)/layout.tsx, because that wraps eleven pages and a trigger
 * there would fire on /settings and /feedback, which show no trade at all.
 *
 * Not in the pages' own bodies either, and this one is a correctness rule
 * rather than a preference: an RSC render is a GET, Next may re-run it on a
 * prefetch or a refresh, and `force-dynamic` does not change that. A trigger
 * that imported rows from a render would be the exact thing
 * api/tradovate/sync's header refuses — which is why that route is a POST. So
 * the automatic trigger is a client effect that makes a POST, and the pages
 * only decide whether it is mounted.
 *
 *
 * WHO IS NOT SHOWN THIS
 * ---------------------
 *
 * Traders who cannot sync: not on the allowlist, or the import flag is off.
 * Both are evaluated SERVER-SIDE in each page, which is the only place they
 * can be — allowlist.ts and isImportEnabled() are server-only — and the page
 * renders {@link ReflectOnlyNote} in this component's place. That is E16 of the
 * Stage 1 investigation built: in a journal, where trades are expected to
 * appear by themselves, silence is the worst available failure, and the
 * allowlist is too small for an explanation that would not identify a person.
 * So the page states what it is showing and stops.
 *
 *
 * WHAT THE TWO TRIGGERS SEND, AND WHY IT DIFFERS
 * ----------------------------------------------
 *
 * The automatic one sends `dayStart` alone; the click sends `dayStart` plus
 * `since = now − 7d`. §A2 measured that the four list reads are unfiltered and
 * cost the same for any window, and that what grows with the window is
 * PRICING, at one contract chain per distinct contract in it. So the narrow
 * window is the cheap one and belongs on the trigger nobody asked for, and
 * "bring me everything you can" belongs on the one they pressed. The route
 * clamps `since` to seven days regardless.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

import { startOfTodayIso } from '@/lib/rules/tradeRuleContext';
import { shareBrokerSync, shouldAutoSync } from '@/lib/tradovate/syncClock';
import {
  describeSyncOutcome,
  readSyncResponse,
  REFLECT_ONLY_NOTE,
  syncChangedRows,
  SYNC_COOLDOWN,
  SYNC_REFLECT_ONLY,
  SYNC_UNAVAILABLE,
  type BrokerSyncOutcome,
  type SyncMessage,
} from '@/lib/tradovate/sync-response';
import { DAY_START_PARAM, MAX_SINCE_AGE_MS, SINCE_PARAM } from '@/lib/tradovate/trading-day';

/** The route. One place, so the component and the tests cannot drift. */
const BROKER_SYNC_PATH = '/api/tradovate/sync';

/**
 * How long to wait before giving up on a sync.
 *
 * Generous on purpose. A cold lambda pays three pricing calls per distinct
 * contract because `unitByContractName` is per-instance (§F5), and the cron's
 * own measurement is two to four seconds for a warm one. A timeout tight
 * enough to catch a hung request would mostly catch slow honest ones, and the
 * trader would be told the broker did not answer when it was about to.
 */
const SYNC_TIMEOUT_MS = 20_000;

export default function BrokerSyncButton({
  userId,
  refreshOnChange = false,
}: {
  /**
   * The signed-in trader. NOT sent anywhere — the route reads the session
   * cookie and would ignore it — it is the throttle key, so that signing out
   * and in as somebody else in the same tab is not silenced by the previous
   * trader's window. See lib/tradovate/syncClock.ts.
   */
  userId: string;
  /**
   * Whether to re-render the server component after a sync that moved rows.
   *
   * /trades and /journal pass this; the DASHBOARD DOES NOT, and that is not an
   * oversight. It already refetches on a `postgres_changes` subscription over
   * `trade_plans` filtered to this user (DashboardClient), so the insert this
   * sync just made is the event it is listening for — a router.refresh() there
   * would re-run a five-hundred-row query to arrive at the same list.
   *
   * Only on a run that CHANGED something (syncChangedRows). "הכל מעודכן" is
   * the common case and it has nothing to re-render for.
   */
  refreshOnChange?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SyncMessage | null>(null);

  // The component can unmount mid-sync — a trader who clicks and immediately
  // navigates — and setState on an unmounted component is a warning plus a
  // leak. The sync itself is NOT cancelled: the rows should still land.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (explicit: boolean) => {
      if (alive.current) setBusy(true);

      const outcome = await shareBrokerSync(userId, Date.now, () =>
        requestSync({ explicit })
      );

      if (alive.current) {
        setBusy(false);
        setMessage(describeSyncOutcome(outcome));
      }

      // Outside the `alive` guard deliberately: if a sync imported rows, the
      // page behind it is stale whether or not this component is still on
      // screen, and router.refresh() is about the route and not about us.
      if (refreshOnChange && syncChangedRows(outcome)) router.refresh();
    },
    [userId, refreshOnChange, router]
  );

  // ── The automatic trigger ────────────────────────────────────────────────
  //
  // Fires on mount and whenever the tab comes back to the foreground, both
  // subject to the same three-minute window, and never while the tab is
  // hidden. The hidden check is worth its line: a dashboard left open
  // overnight would otherwise pull every three minutes until morning, and
  // nobody is reading it. Coming back to the foreground is, by contrast,
  // exactly the moment a trader returns to the screen after closing a
  // position — so that is when the re-fire earns its request.
  useEffect(() => {
    const attempt = () => {
      if (document.visibilityState !== 'visible') return;
      if (!shouldAutoSync(userId, Date.now())) return;
      void run(false);
    };

    attempt();
    document.addEventListener('visibilitychange', attempt);
    return () => document.removeEventListener('visibilitychange', attempt);
  }, [userId, run]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void run(true)}
        disabled={busy}
        // The CSV button's metrics, not the journal toolbar's: this sits beside
        // JournalExport in the page header, and the filter row's px-4 h-11
        // would make it the loudest thing on the page.
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150 disabled:opacity-40"
        style={{
          background: 'var(--color-tg-surface)',
          borderColor: 'var(--color-tg-border)',
          color: 'var(--color-tg-text-2)',
        }}
        title="סנכרן עסקאות מ-Tradovate"
      >
        <RefreshCw aria-hidden="true" size={13} className={busy ? 'animate-spin' : undefined} />
        סנכרן עכשיו
      </button>

      {/* Polite, not assertive: this is the outcome of something the trader
          asked for and can read when they get to it, and the automatic
          trigger would otherwise interrupt a screen reader mid-sentence on
          every page entry. */}
      <div aria-live="polite" className="text-[11px] leading-snug text-end">
        {message && (
          <>
            <span style={{ color: message.problem ? 'var(--color-tg-text)' : 'var(--color-tg-text-2)' }}>
              {message.text}
            </span>
            {/* ONE BLOCK PER QUALIFIER (REF-117 Stage 6). It was a single
                nullable string; there are now two independent things that can
                both be true of one run — a contract whose trades could not be
                stated, and a position still open — and neither may suppress
                the other. lib/tradovate/sync-response.ts orders them. */}
            {message.details.map((detail) => (
              <span key={detail} className="block" style={{ color: 'var(--color-tg-text-2)' }}>
                {detail}
              </span>
            ))}
            {message.reconnect && (
              // The same href the Settings card and TodayContextPanel use. A
              // plain link: the connect flow is a server route and nothing
              // about the connection is handled here.
              <a
                href="/api/tradovate/connect"
                className="block underline"
                style={{ color: 'var(--color-tg-text)' }}
              >
                חבר מחדש
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One POST, parsed into an outcome. Never throws and never rejects.
 *
 * A failed request IS one of the states — that is what the union is for — and
 * a rejection here would propagate into {@link shareBrokerSync}, where every
 * other caller holding the shared promise would receive it too. The mapping
 * matches lib/rules/brokerDayContext.ts' `requestBrokerDay`: a 401 or 403 is
 * `reflect_only` (no broker view, and the session is the app shell's problem,
 * not this button's), anything else unreadable is `broker_unavailable`.
 *
 * 429 IS READ, AND IT IS WHY THIS FUNCTION HAD TO CHANGE (REF-112 §4.5 item 2).
 * The route's server-side cooldown answers 429, which fell into `!res.ok` and
 * therefore rendered "לא הצלחנו למשוך עסקאות מ-Tradovate" — a sentence that
 * blames the broker for our own cap, in front of a trader whose connection is
 * working perfectly. That is the same defect §2 of the REF-112 investigation
 * records on the OAuth paths, where `?tradovate=not_available` has no reader at
 * all: a refusal nobody translates is a refusal the trader cannot act on.
 *
 * THE STATUS CODE AND NOT THE BODY. `message` is on the response and is the
 * same string, but reading it would mean trusting server copy to render in a
 * client component — and the body is also what an edge proxy is most likely to
 * replace on a 429 with its own HTML. The code is the contract; the sentence
 * comes from lib/tradovate/sync-response.ts like every other sentence here.
 */
async function requestSync({ explicit }: { explicit: boolean }): Promise<BrokerSyncOutcome> {
  const params = new URLSearchParams({ [DAY_START_PARAM]: startOfTodayIso() });

  // Only the deliberate trigger reaches back a week. See the header on cost.
  if (explicit) {
    params.set(SINCE_PARAM, new Date(Date.now() - MAX_SINCE_AGE_MS).toISOString());
  }

  try {
    const res = await fetch(`${BROKER_SYNC_PATH}?${params}`, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) return SYNC_REFLECT_ONLY;
    // Before the `!res.ok` catch-all, which is what used to swallow it.
    if (res.status === 429) return SYNC_COOLDOWN;
    if (!res.ok) return SYNC_UNAVAILABLE;

    return readSyncResponse(await res.json());
  } catch {
    // Offline, aborted, timed out, or a body that is not JSON.
    return SYNC_UNAVAILABLE;
  }
}

/**
 * What stands where the button would be, for a trader who cannot sync (E16).
 *
 * Rendered by the pages, which are the only things that can decide this: both
 * halves of `canSync` — the allowlist and the import flag — are server-only.
 *
 * Not a client component by necessity; it lives here because it is the other
 * half of the same decision, and splitting them across files is how the two
 * drift. It has no state, no effect and no handler, so being in the client
 * bundle costs a span.
 */
export function ReflectOnlyNote() {
  return (
    <p className="text-[11px] leading-snug" style={{ color: 'var(--color-tg-muted)' }}>
      {REFLECT_ONLY_NOTE}
    </p>
  );
}
