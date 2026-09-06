'use client';

/**
 * The destructive section of Settings (REF-67).
 *
 * Deliberately separated from everything above it — its own heading, its own
 * red-bordered card, at the bottom of the page — because it sits on a screen
 * whose other controls are all reversible toggles. It must not read as one more
 * setting.
 *
 * The copy states what is deleted before asking for anything, and says plainly
 * that it cannot be undone. The form only appears after an explicit click, so
 * the password field is never sitting on screen next to a delete button.
 *
 *
 * Why the password field fights password managers
 * -----------------------------------------------
 * This was found the hard way: a tester typed a deliberately wrong password to
 * check the rejection path, a password manager overwrote the field with the
 * real one, and the account was correctly and irreversibly deleted. The server
 * behaved exactly as designed — it re-authenticated a valid password — which is
 * the point. Re-authentication is only a confirmation if the value came from
 * the person, and a field a manager can fill confirms nothing.
 *
 * So the field is defended in layers, weakest to strongest:
 *
 *   1. autoComplete="new-password" and vendor opt-out data attributes. Widely
 *      but not universally honoured; autoComplete="off" is ignored outright by
 *      most managers, which is why it is not used here.
 *   2. An id and name that do not read as a login field, so name-matching
 *      heuristics do not latch onto it.
 *   3. readOnly until first focus. Managers skip readonly inputs, which stops
 *      fill-on-insert. Cleared imperatively in the focus handler rather than by
 *      state, so the first keystroke is never swallowed by the re-render.
 *   4. Cleared when the form opens, and again on a short timer while the field
 *      is still untouched, because managers fill asynchronously after mount.
 *   5. The one that actually catches the failure above: every accepted change
 *      must be traceable to a keystroke or a paste. Autofill raises an input
 *      event with no preceding keydown, so a value that appears without one is
 *      rejected, the field is cleared, and the user is told to type it. This is
 *      the only layer that survives a manager filling *after* the user has
 *      already focused and typed.
 *
 * Paste is deliberately still allowed — blocking it pushes people toward
 * weaker, memorable passwords, and a paste is an intentional act.
 *
 * The confirmation field carries layers 1-3 as well. It holds no secret, so
 * this is not about leaking one: a manager that offers to fill it has decided
 * this is a login form, and its icon over a field whose whole job is to slow
 * the user down invites exactly the reflex the field exists to prevent.
 */

import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { DELETE_CONFIRMATION_WORD, matchesConfirmation } from '@/lib/account/confirmation';
import { createClient } from '@/lib/supabase/client';

/** What the user is told will be erased. Plain nouns, no product jargon. */
const DELETED_ITEMS = [
  'כל העסקאות, התחקירים והציונים שלך',
  'המחברת, הסטאפים והתמונות שהעלית',
  'האסטרטגיות, החוקים והיסטוריית ההתראות',
  'התובנות והסיכומים שנוצרו על ידי ה-AI',
  'החיבור לברוקר והפרטים שנשמרו איתו',
  'פרטי החשבון והגישה אליו',
];

/**
 * How recently a keydown or paste must have happened for an input event to
 * count as user-originated. Typing produces the two within the same task; an
 * autofill produces an input event with nothing before it at all.
 */
const USER_INPUT_WINDOW_MS = 150;

/** Not "password" anywhere: manager heuristics match on id and name. */
const VERIFY_FIELD_ID = 'account-erasure-verify';

/** Attribute-level opt-outs for the major managers. */
const MANAGER_OPT_OUTS = {
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

export default function DeleteAccountSection() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [autofillRejected, setAutofillRejected] = useState(false);

  /**
   * Whether the user has focused the field. Held twice on purpose: state drives
   * the rendered readOnly attribute, the ref is what the clearing timers read
   * without re-subscribing. Reading a ref during render is a lint error, and
   * rightly so.
   */
  const [touched, setTouched] = useState(false);
  const touchedRef = useRef(false);

  /**
   * The same readOnly-until-focus trick for the confirmation field. Only that
   * one layer: the word is printed on the label above the field, so a manager
   * filling it leaks nothing and the strict keystroke check the password gets
   * would only punish someone pasting a word we just showed them.
   */
  const [wordTouched, setWordTouched] = useState(false);

  const passwordRef = useRef<HTMLInputElement>(null);
  /** Timestamp of the last keydown or paste on the field. */
  const lastUserInputRef = useRef(0);

  // Clear on open, then again while the field is still untouched: managers fill
  // asynchronously, sometimes several hundred ms after the node is inserted.
  // The timers stop mattering the moment the user focuses the field, so they
  // can never wipe something being typed.
  useEffect(() => {
    if (!open) return;

    const clear = () => {
      const el = passwordRef.current;
      if (el && el.value !== '') {
        el.value = '';
        setAutofillRejected(true);
      }
      setPassword('');
    };

    clear();
    const timers = [60, 250, 800].map((ms) =>
      window.setTimeout(() => {
        if (!touchedRef.current) clear();
      }, ms)
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [open]);

  function noteUserInput() {
    lastUserInputRef.current = Date.now();
  }

  function handlePasswordChange(e: React.ChangeEvent<HTMLInputElement>) {
    const cameFromUser = Date.now() - lastUserInputRef.current < USER_INPUT_WINDOW_MS;

    if (!cameFromUser) {
      // Filled by something that is not the person at the keyboard. Refuse it
      // outright — an irreversible action must never run on a value the user
      // did not enter, even when that value is correct.
      e.target.value = '';
      setPassword('');
      setAutofillRejected(true);
      return;
    }

    setAutofillRejected(false);
    setPassword(e.target.value);
  }

  function resetForm() {
    setOpen(false);
    setPassword('');
    setConfirmation('');
    setError('');
    setAutofillRejected(false);
    setTouched(false);
    touchedRef.current = false;
    setWordTouched(false);
    lastUserInputRef.current = 0;
  }

  // The confirmation word must actually match before the button is live, so
  // reaching the delete action requires the user to have typed both fields.
  const canSubmit = password.length > 0 && matchesConfirmation(confirmation) && !busy;

  async function handleDelete() {
    setBusy(true);
    setError('');

    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, confirmation }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };

      if (!res.ok) {
        // The route supplies a message for every failure it models, and each
        // one says whether any data was deleted. This fallback is only for a
        // response that carried none — a session that expired, a malformed
        // body — so it states the one thing true of all of them: the request
        // did not get as far as deleting anything.
        setError(data.message ?? 'הבקשה נדחתה ולא נמחק דבר. רענן את הדף ונסה שוב.');
        setBusy(false);
        return;
      }

      // The account is gone; the session cookie is not, and every page it can
      // still open would fail on a missing profile. Clear it locally, then do a
      // full navigation rather than a router push, so nothing is served from
      // the client-side cache of a user who no longer exists.
      await createClient().auth.signOut().catch(() => {});
      window.location.assign('/');
    } catch {
      setError('שגיאת רשת. בדוק את החיבור ונסה שוב.');
      setBusy(false);
    }
  }

  return (
    <div dir="rtl" className="flex flex-col gap-3">
      <h2 className="text-base font-bold text-tg-text">אזור מסוכן</h2>

      {/* Not the shared Card component: that one paints a turquoise-tinted
          surface via inline styles, and this section has to read as unlike
          every other card on the page rather than as one more of them. */}
      <div
        className="rounded-2xl border p-4"
        style={{
          background: 'var(--color-tg-danger-muted)',
          borderColor: 'rgba(239, 68, 68, 0.35)',
        }}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle
            aria-hidden="true"
            size={20}
            className="shrink-0 mt-0.5"
            style={{ color: 'var(--color-tg-danger)' }}
          />

          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-tg-text">מחיקת החשבון</h3>

            <p className="text-xs text-tg-text-2 mt-1.5 leading-relaxed">
              מחיקת החשבון מסירה לצמיתות את כל מה ששמרת ב-Reflect:
            </p>

            <ul className="mt-2 flex flex-col gap-1">
              {DELETED_ITEMS.map((item) => (
                <li key={item} className="text-xs text-tg-text-2 flex gap-2">
                  <span aria-hidden="true" className="text-tg-muted">
                    &#8226;
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <p
              className="text-xs font-semibold mt-3 leading-relaxed"
              style={{ color: 'var(--color-tg-danger)' }}
            >
              המחיקה מתבצעת מיד ואי אפשר לבטל אותה. אין תקופת שחזור ואין גיבוי —
              הנתונים לא ניתנים לשחזור גם על ידי התמיכה.
            </p>

            {!open ? (
              <Button variant="danger" size="md" className="mt-4" onClick={() => setOpen(true)}>
                מחיקת החשבון
              </Button>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                <Input
                  ref={passwordRef}
                  id={VERIFY_FIELD_ID}
                  name={VERIFY_FIELD_ID}
                  type="password"
                  label="הסיסמה שלך"
                  // Not "off": most managers ignore it on password fields.
                  autoComplete="new-password"
                  autoCorrect="off"
                  spellCheck={false}
                  dir="ltr"
                  {...MANAGER_OPT_OUTS}
                  // Managers skip readonly fields; cleared imperatively below so
                  // the first keystroke is not lost to a re-render.
                  readOnly={!touched}
                  value={password}
                  onFocus={(e) => {
                    // Imperative first: the state update below re-renders to the
                    // same value, but this makes the field writable in the same
                    // task as the focus, so the first keystroke always lands.
                    e.target.readOnly = false;
                    touchedRef.current = true;
                    setTouched(true);
                  }}
                  onKeyDown={noteUserInput}
                  onPaste={noteUserInput}
                  onChange={handlePasswordChange}
                  hint="נדרשת כדי לוודא שזה אתה ולא מישהו שהשאיר את הדפדפן פתוח. הקלד אותה ידנית."
                  disabled={busy}
                />

                {autofillRejected && (
                  <p role="alert" className="text-xs" style={{ color: 'var(--color-tg-warning)' }}>
                    מנהל הסיסמאות מילא את השדה אוטומטית והתוכן נמחק. הקלד את הסיסמה
                    ידנית — מחיקת חשבון לא תתבצע על סמך ערך שלא הקלדת בעצמך.
                  </p>
                )}

                <Input
                  id="account-erasure-word"
                  name="account-erasure-word"
                  type="text"
                  label={`הקלד ${DELETE_CONFIRMATION_WORD} כדי לאשר`}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  {...MANAGER_OPT_OUTS}
                  // A text input sitting next to a password input is what a
                  // manager classifies as the username half of a login form,
                  // which is why the opt-out attributes above are not enough on
                  // their own to keep its icon out of the field.
                  readOnly={!wordTouched}
                  onFocus={(e) => {
                    e.target.readOnly = false;
                    setWordTouched(true);
                  }}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  disabled={busy}
                />

                {error && (
                  <p role="alert" className="text-xs text-tg-danger">
                    {error}
                  </p>
                )}

                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="danger"
                    size="md"
                    loading={busy}
                    disabled={!canSubmit}
                    onClick={handleDelete}
                  >
                    מחק את החשבון לצמיתות
                  </Button>
                  <Button variant="secondary" size="md" disabled={busy} onClick={resetForm}>
                    ביטול
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
