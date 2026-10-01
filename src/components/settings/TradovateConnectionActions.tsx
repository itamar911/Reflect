'use client';

/**
 * The connect / disconnect half of the Tradovate integration card in Settings.
 *
 * Only this part is a client component. The card shell, heading, badge and
 * description stay in the server page, which is also where the allowlist is
 * evaluated — allowlist.ts reads process.env and is server-only, so the decision
 * arrives here as a prop rather than being re-derived.
 *
 * The connection state arrives as two plain booleans rather than the
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
 * The note now names a path, hedged — see RevokeNote below for why it is worded
 * the way it is. It is still not documented anywhere: api.tradovate.com
 * publishes no endpoint list at all, and the OAuth material only refers to
 * "your authorized-apps settings" without saying where those are. The path in
 * the copy is a hand-verified observation, not a citation, and it is presented
 * as one.
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

export interface TradovateConnectionActionsProps {
  /** Whether this user is on the Tradovate allowlist. Decided on the server. */
  canConnect: boolean;
  /** Whether a connection row exists at all, whatever state it is in. */
  hasConnection: boolean;
  /** Whether that row still holds a usable token. */
  isActive: boolean;
}

export default function TradovateConnectionActions({
  canConnect,
  hasConnection,
  isActive,
}: TradovateConnectionActionsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Set once a disconnect has succeeded in this session. */
  const [disconnected, setDisconnected] = useState(false);

  if (!canConnect) {
    return (
      <button
        disabled
        className="mt-3 w-full py-2.5 rounded-xl text-sm font-semibold cursor-not-allowed"
        style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}
      >
        חבר ברוקר
      </button>
    );
  }

  // A row that exists but is not active still has to be disconnectable: the
  // token is dead, but the row and our stored copy of it are not, and the user
  // may well want both gone rather than replaced.
  const showDisconnect = hasConnection && !disconnected;
  const connectedNow = isActive && !disconnected;

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
    <div className="mt-3 flex flex-col gap-3">
      {/* One live region holding the connection's state AND the outcome of
          disconnecting, rather than a separate announcer for the outcome.
          A live region a screen reader first meets at the moment its content
          arrives is often not announced, and a display:none one is not in the
          accessibility tree at all — so the element that will carry the
          "disconnected" message is already present, and already reading out the
          status, in every state from which disconnecting is possible.

          empty:hidden therefore only ever applies to the never-connected case,
          which has no disconnect button and so can never need to announce
          anything; it is there to keep the parent's gap from opening around an
          element with nothing in it. */}
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

      {/* Offered whenever there is nothing live to disconnect: no row, a lapsed
          one, or one we just deleted. A plain link, not a fetch — the flow ends
          on Tradovate's own consent screen, so it has to be a top-level
          navigation. */}
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
  );
}
