'use client';

/**
 * The whole interior of the Tradovate integration card in Settings.
 *
 * It owns the badge as well as the actions, and that is the point. The badge
 * used to be server-rendered in the page while the actions below it were client
 * state, so a successful disconnect updated the body — "החיבור נותק", the button
 * flipping to "חבר מחדש" — while the badge above it still read "מחובר" until the
 * next refresh. The card contradicted itself at exactly the moment the user
 * acted on it. One component, one `disconnected` flag, every label derived from
 * it.
 *
 * Only the card shell (<Card>) and the allowlist decision stay on the server:
 * allowlist.ts reads process.env and is server-only, so that arrives as a prop.
 *
 * The connection state arrives as plain booleans rather than the
 * ConnectionStatus union, so nothing in this file imports lib/tradovate/
 * connections.ts. That module pulls in the service-role Supabase client; a
 * type-only import would be erased, but the rule is easier to keep if a client
 * component simply never names it.
 *
 *
 * Why the disconnect copy says what it says
 * ----------------------------------------
 * Disconnecting does NOT revoke the authorization. NinjaTrader API Support
 * confirmed in writing (24 Sep) that a vendor has no endpoint for revoking an
 * OAuth grant, which matches the API reference publishing none. All
 * /api/tradovate/disconnect can do is delete our stored token, drop it from the
 * server-side cache and stop renewing; the grant itself stays live in the user's
 * Tradovate account until they remove it there.
 *
 * A user who clicks "disconnect" reasonably believes the authorization is gone,
 * so the gap is stated at the control itself and again on the confirmation —
 * before the click, because that is when it can still change what they do, and
 * after it, because that is when they would otherwise assume they were finished.
 *
 * The note names a path, hedged — see RevokeNote below for why it is worded the
 * way it is. It is still not documented anywhere: api.tradovate.com publishes no
 * endpoint list at all, and the OAuth material only refers to "your
 * authorized-apps settings" without saying where those are. The path in the copy
 * is a hand-verified observation, not a citation, and is presented as one.
 */

import { Plug, Unplug } from 'lucide-react';
import { useState } from 'react';

import Button from '@/components/ui/Button';
// Browser-safe and pure, like lib/tradovate/sync-response.ts: a sentence and
// nothing else. It does not reach connections.ts, so the rule in the header
// above — a client component never names that module — still holds.
import {
  CONNECTION_EXPIRING_NOTE,
  NOT_AVAILABLE_NOTE,
  NO_LIVE_ENTITLEMENT_NOTE,
} from '@/lib/tradovate/notices';

/**
 * The one thing the disconnect action cannot do, stated in full.
 *
 * Rendered both before and after disconnecting, from this single component, so
 * the two can never drift into saying different things.
 *
 * The path is hedged on purpose. It was verified by hand in Tradovate, but as
 * the account that OWNS the registered app, where the section read "No
 * authorized apps found" — so how it looks to an ordinary user who only
 * authorized Reflect has not been seen. The copy therefore tells them what to
 * look for first and offers the path as where it was found, not as a promise,
 * and says outright that the name or location may differ for them.
 *
 * The path itself is wrapped in dir="ltr": it is three English labels inside an
 * RTL sentence, and without it the bidi algorithm reorders the separators and
 * the user is told to follow a path that reads backwards.
 */
function RevokeNote() {
  return (
    <p className="text-xs text-tg-text-2 leading-relaxed">
      ניתוק מ-Reflect מוחק את ההרשאה השמורה אצלנו ומפסיק את משיכת הנתונים. כדי להסיר את
      ההרשאה גם מצד Tradovate, יש להיכנס להגדרות החשבון שלך ב-Tradovate ולאתר את רשימת
      האפליקציות שאישרת בגישת OAuth — אצלנו היא הופיעה תחת{' '}
      <span dir="ltr" className="inline-block font-medium text-tg-text">
        Settings &rsaquo; App Permissions &rsaquo; Authorized Apps
      </span>{' '}
      — ולהסיר משם את Reflect. ייתכן שהשם או המיקום המדויק יהיו שונים בחשבון שלך.
    </p>
  );
}

/**
 * How broker data arrives, and the one window in which it does not.
 *
 * THIS CARD IS THE ONLY PLACE IN THE PRODUCT THAT EXPLAINS THE MECHANISM. The
 * journal's queue banner explains what to do with a trade once it is here;
 * nothing else explains how it got here.
 *
 * It replaces a sentence that read "אין סנכרון אוטומטי ברקע", which has been
 * false since REF-117 Stage 2b: vercel.json registers two daily passes
 * (/api/cron/tradovate-import at 20:00 UTC and /api/cron/tradovate-orders at
 * 21:30) and BOTH import trades — the second one calls the same
 * `syncUserTrades`, as import-cron.ts says in as many words. A card that denies
 * having a background sync cannot then explain a cutoff inside one, so the
 * false sentence is replaced rather than joined.
 *
 * Why it is worded the way it is
 * ------------------------------
 * - **"בסביבות 01:00", hedged.** Tradovate clears the day's fills, pairs,
 *   positions and orders at the daily reset (all four measured at
 *   `depthDays = 0`), and the reset is the US futures roll — which
 *   trading-day.ts is explicit about having INFERRED at 17:00 CT from a support
 *   article it could not fetch. 17:00 CT is 01:00 Israel in both DST regimes,
 *   and the card already has a precedent for hedging a hand-verified fact (see
 *   RevokeNote's "ייתכן שהשם או המיקום המדויק יהיו שונים").
 *
 *   Naming 01:00 is also the SAFE DIRECTION. Israel and the US change clocks a
 *   week apart, and in that gap the real reset is 02:00 Israel — later. A
 *   trader acting on "before 01:00" is never caught out by the mismatch.
 *
 * - **No UTC, no "cron", no "sync job", no "API".** "פעמיים בכל לילה" is the
 *   whole of what a trader needs from the schedule.
 *
 * - **"תגיע לכאן רק אם…" and not "תאבד".** Nothing is lost from Reflect — a
 *   trade inside the window was never imported, because Tradovate dropped it
 *   and there is no backfill at any price. "Lost" would send someone looking
 *   for a deleted row.
 *
 * - **No advice shape.** This is product mechanics, not a trading
 *   recommendation, which is the line TodayContextPanel's NinjaTrader
 *   compliance ban is drawn around. Do NOT extend it into "אל תסחר בשעות
 *   האלה", which would cross it.
 *
 * Exported because a suite reads it: broker-import-check.ts asserts the old
 * false sentence is gone and that an hour is still named. That assertion is the
 * tripwire that would have caught the drift when the cron moved.
 */
export const SYNC_NOTE =
  'כשתפתח תוכנית עסקה Reflect מושך מהברוקר את העסקאות שלך באותו רגע, ובנוסף אנחנו ' +
  'מושכים אותן פעמיים בכל לילה. Tradovate מוחק את רשימת העסקאות של היום בסביבות ' +
  '01:00, ולכן עסקה שנסגרה אחרי 00:30 תגיע לכאן רק אם תפתח את Reflect לפני השעה הזאת.';

/**
 * The clock tokens inside SYNC_NOTE, as a split pattern.
 *
 * `01:00` and `00:30` are LTR tokens inside RTL sentences, and the bidi
 * algorithm reorders a bare `00:30` against its neighbours — the same bug
 * ref-107-unlink.md §C recorded shipping once already. Splitting on a capturing
 * group keeps the delimiters, so the paragraph below is rendered FROM the
 * exported constant rather than beside it: there is one copy of this sentence,
 * and the suite reads the one the user sees.
 *
 * No /g flag on purpose — `test()` on a global regex carries `lastIndex`
 * between calls and would answer differently on alternate segments.
 */
const CLOCK = /(\d{2}:\d{2})/;

function SyncNote() {
  return (
    <p className="text-xs text-tg-muted mt-1.5">
      {SYNC_NOTE.split(CLOCK).map((piece, index) =>
        CLOCK.test(piece) ? (
          <span key={index} dir="ltr" className="inline-block">
            {piece}
          </span>
        ) : (
          piece
        )
      )}
    </p>
  );
}

/**
 * The app's focus convention, copied from AccessibilityWidget: a turquoise ring
 * on keyboard focus only.
 *
 * A ring rather than an outline, because the shared Button sets
 * `focus:outline-none` in its base classes — a `focus-visible:outline-*` would
 * be arguing with it. A ring is a box-shadow and is unaffected. No ring-offset:
 * the offset colour would have to match whichever surface the control happens to
 * sit on, and these sit on two different ones.
 */
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary';

export interface TradovateConnectionCardProps {
  /** Whether this user is on the Tradovate allowlist. Decided on the server. */
  canConnect: boolean;
  /** Whether a connection row exists at all, whatever state it is in. */
  hasConnection: boolean;
  /** Whether that row still holds a usable token. */
  isActive: boolean;
  /**
   * Whether the server could not read the connection at all.
   *
   * Distinct from `hasConnection: false`, and the distinction is the point: not
   * knowing is not the same as knowing there is nothing, and rendering them the
   * same way is how a connected user gets told they are not connected.
   */
  readFailed: boolean;
  /**
   * Whether the connection that just completed reported no live and no funded
   * entitlement (REF-112 §5.17, item 5).
   *
   * ONE SHOT AND NOT A STATE. It comes off `?tradovate=connected_no_live` on
   * the redirect the callback issued, so it is true on exactly one page view
   * and gone the moment the trader navigates — which is what "show once on
   * connect" means with nothing stored and nothing to clear.
   *
   * IT DOES NOT CHANGE THE BADGE, and that is the decision rather than an
   * omission: the connection IS made, "מחובר" is correct, and the missing
   * accounts are a separate fact underneath it. See the sentence in
   * lib/tradovate/notices.ts on why both halves are news.
   */
  noLiveAccounts?: boolean;
  /**
   * Whether an OAuth attempt was just refused because the connection is not
   * open to this account (REF-112-C item 2).
   *
   * ONE SHOT AND NOT A STATE, exactly like {@link noLiveAccounts}: it comes off
   * `?tradovate=not_available` on the redirect /api/tradovate/connect or
   * /api/tradovate/callback just issued, so it is true on one page view and
   * gone the moment the trader navigates.
   *
   * IT DOES NOT CHANGE THE BADGE. `זמין בקרוב` is the STATE and already says
   * what it needs to on every view; this is the one extra fact a trader who
   * just pressed the button needs — that the press was refused, and the grey
   * control was not a rendering accident. See NOT_AVAILABLE_NOTE in
   * lib/tradovate/notices.ts for the wording.
   *
   * NOT GATED ON `canConnect`, deliberately. The two disagree only in one
   * state: the restriction changed between this page rendering and the route
   * answering. The route is the authority on what actually happened — it is
   * what refused — so its answer is the one shown, even standing next to a
   * button this render believes is live.
   */
  notAvailable?: boolean;
  /**
   * Whether the connection's refresh deadline is near and nothing has renewed
   * it (REF-112 follow-up item 4).
   *
   * A STATE AND NOT A ONE-SHOT, unlike the two flags above: it is re-derived
   * from the stored row on every view of this page, and it stays true until
   * something renews the connection or it dies. The server decides it — see
   * `refreshDeadlineNear` in lib/tradovate/notices.ts — and what arrives here
   * is a boolean, never the deadline, so this component cannot print an instant
   * that the copy has no business promising.
   *
   * A BOOLEAN AND NOT A `ConnectionStatus`, for the reason this file's header
   * gives: connection state reaches this client component as plain booleans so
   * that it never names lib/tradovate/connections.ts, which holds the
   * service-role client.
   *
   * IT DOES NOT CHANGE THE BADGE. The connection is working — "מחובר" is
   * correct, and that is the entire point of warning before it stops rather
   * than after.
   */
  expiringSoon?: boolean;
}

export default function TradovateConnectionCard({
  canConnect,
  hasConnection,
  isActive,
  readFailed,
  noLiveAccounts = false,
  notAvailable = false,
  expiringSoon = false,
}: TradovateConnectionCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Set once a disconnect has succeeded in this session. */
  const [disconnected, setDisconnected] = useState(false);

  // Everything below, badge included, is derived from these two. A disconnect
  // flips `disconnected` and the whole card moves together.
  const connectedNow = isActive && !disconnected;
  // A row that exists but is not active still has to be disconnectable: the
  // token is dead, but the row and our stored copy of it are not, and the user
  // may well want both gone rather than replaced.
  const showDisconnect = canConnect && !readFailed && hasConnection && !disconnected;

  const badge = !canConnect
    ? 'זמין בקרוב'
    : readFailed
      ? 'מצב לא ידוע'
      : connectedNow
        ? 'מחובר'
        : 'בדיקה מוקדמת';

  async function handleDisconnect() {
    setBusy(true);
    setError('');

    try {
      const res = await fetch('/api/tradovate/disconnect', { method: 'POST' });
      if (!res.ok) {
        setError('הניתוק נכשל. רענן את הדף ונסה שוב.');
        setBusy(false);
        return;
      }
      setDisconnected(true);
      setBusy(false);
    } catch {
      setError('שגיאת רשת. בדוק את החיבור ונסה שוב.');
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start gap-3">
      <Plug aria-hidden="true" size={20} style={{ color: '#00d2d2' }} className="shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-bold text-tg-text">חיבור לחשבון הברוקר</h3>
          <span
            className="px-2 py-0.5 rounded-full text-xs font-semibold"
            style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}
          >
            {badge}
          </span>
        </div>

        <SyncNote />

        {/* REF-112-C item 2 — the refusal, said out loud.
            ABOVE the controls and outside both `canConnect` branches: it
            describes what just happened when the trader pressed a button, so
            it belongs where they will look when they land back here, and it is
            the same sentence whichever of the two OAuth paths refused them.

            role="status" and not role="alert". A restriction is not the page
            being wrong about something — it is an answer, and `aria-live`
            without the interruption is how the rest of this card announces
            one. */}
        {notAvailable && (
          <p
            role="status"
            className="mt-3 text-xs font-semibold leading-relaxed"
            style={{ color: 'var(--color-tg-warning)' }}
          >
            {NOT_AVAILABLE_NOTE}
          </p>
        )}

        {!canConnect && (
          <button
            disabled
            className="mt-3 w-full py-2.5 rounded-xl text-sm font-semibold cursor-not-allowed"
            style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}
          >
            חבר ברוקר
          </button>
        )}

        {canConnect && readFailed && (
          <div className="mt-3 flex flex-col gap-3">
            {/* role="alert": this is the page being wrong about something the
                user can see, not a passive status. */}
            <p
              role="alert"
              className="text-xs font-semibold leading-relaxed"
              style={{ color: 'var(--color-tg-warning)' }}
            >
              לא הצלחנו לקרוא את מצב החיבור כרגע, כך שייתכן שקיים חיבור פעיל שאינו מוצג
              כאן. רענן את הדף כדי לנסות שוב.
            </p>

            {/* Connect stays available — it is an upsert, so it is safe whatever
                the true state turns out to be. Disconnect does not: offering to
                delete a connection we have no evidence exists is not a choice we
                can put in front of someone honestly. */}
            <a
              href="/api/tradovate/connect"
              className={`w-full py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 ${FOCUS_RING}`}
              style={{ background: '#00d2d2', color: 'var(--color-tg-bg)' }}
            >
              <Plug aria-hidden="true" size={16} />
              חבר ברוקר
            </a>
          </div>
        )}

        {canConnect && !readFailed && (
          <div className="mt-3 flex flex-col gap-3">
            {/* One live region holding the connection's state AND the outcome of
                disconnecting, rather than a separate announcer for the outcome.
                A live region a screen reader first meets at the moment its
                content arrives is often not announced, and a display:none one is
                not in the accessibility tree at all — so the element that will
                carry the "disconnected" message is already present, and already
                reading out the status, in every state from which disconnecting
                is possible.

                empty:hidden therefore only ever applies to the never-connected
                case, which has no disconnect button and so can never need to
                announce anything; it is there to keep the parent's gap from
                opening around an element with nothing in it. */}
            <div role="status" aria-live="polite" className="flex flex-col gap-2 empty:hidden">
              {connectedNow && !noLiveAccounts && (
                <p className="text-xs font-semibold text-tg-text">החשבון מחובר.</p>
              )}

              {/* REF-112 §5.17, item 5. REPLACES "החשבון מחובר." rather than
                  sitting under it, because it says that and more: "החשבון
                  מחובר, אבל…" is one sentence, and printing the short form
                  above the long one would be the same news twice. Warning
                  colour, because a connection with nothing behind it is not
                  the outcome the trader pressed the button for. */}
              {connectedNow && noLiveAccounts && (
                <p className="text-xs font-semibold" style={{ color: 'var(--color-tg-warning)' }}>
                  {NO_LIVE_ENTITLEMENT_NOTE}
                </p>
              )}

              {/* REF-112 follow-up item 4. BEFORE THE SENTENCE BELOW, AND THE
                  TWO CAN NEVER BOTH RENDER: this one requires a connection
                  that still works and that one requires a row that has
                  stopped. It sits here because the order on the screen should
                  be the order in time — the warning, then the failure.

                  The CONSTANT and not noticeLine(): /settings takes its
                  connection state as booleans (see the header), so reaching
                  for the notices renderer here would pull a wire type and an
                  ordering rule into a card with one fact to state. The
                  sentence itself is shared, because the same words rendered
                  from two files is a string that drifts. */}
              {connectedNow && expiringSoon && (
                <p className="text-xs font-semibold" style={{ color: 'var(--color-tg-warning)' }}>
                  {CONNECTION_EXPIRING_NOTE}
                </p>
              )}

              {showDisconnect && !connectedNow && (
                <p className="text-xs font-semibold" style={{ color: 'var(--color-tg-warning)' }}>
                  ההרשאה השמורה פגה. יש לחבר מחדש כדי להמשיך.
                </p>
              )}

              {disconnected && (
                <>
                  <p className="text-xs font-semibold text-tg-text">
                    החיבור נותק וההרשאה השמורה נמחקה.
                  </p>
                  <RevokeNote />
                </>
              )}
            </div>

            {error && (
              <p role="alert" className="text-xs text-tg-danger">
                {error}
              </p>
            )}

            {/* Offered whenever there is nothing live to disconnect: no row, a
                lapsed one, or one we just deleted. A plain link, not a fetch —
                the flow ends on Tradovate's own consent screen, so it has to be
                a top-level navigation. */}
            {!connectedNow && (
              <a
                href="/api/tradovate/connect"
                className={`w-full py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 ${FOCUS_RING}`}
                style={{ background: '#00d2d2', color: 'var(--color-tg-bg)' }}
              >
                <Plug aria-hidden="true" size={16} />
                {hasConnection ? 'חבר מחדש' : 'חבר ברוקר'}
              </a>
            )}

            {showDisconnect && (
              <>
                <RevokeNote />
                <Button
                  variant="secondary"
                  size="md"
                  fullWidth
                  loading={busy}
                  onClick={handleDisconnect}
                  className={FOCUS_RING}
                >
                  <Unplug aria-hidden="true" size={16} />
                  נתק את החיבור
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
