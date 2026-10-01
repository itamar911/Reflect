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
}

export default function TradovateConnectionCard({
  canConnect,
  hasConnection,
  isActive,
  readFailed,
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

        <p className="text-xs text-tg-muted mt-1.5">
          כשתפתח תוכנית עסקה, Reflect ימשוך מהברוקר את נתוני העסקאות שלך באותו רגע. אין
          סנכרון אוטומטי ברקע.
        </p>

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
              {connectedNow && <p className="text-xs font-semibold text-tg-text">החשבון מחובר.</p>}

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
