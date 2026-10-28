'use client';

/**
 * "שתף את היום" — the dashboard control that mints a public link
 * (REF-125 Stage 2 item 5).
 *
 * SELF-CONTAINED ON PURPOSE. DashboardClient is already ~1,900 lines and the
 * page's own comments twice justify keeping a stateless addition OUT of it
 * (the account chip, the broker notices). This owns its own fetch, its own
 * dialog and its own feedback, so the header gains one element and no state.
 *
 *
 * IT HIDES ITSELF WHEN THE TABLE IS NOT THERE
 * -------------------------------------------
 *
 * Migrations are run by hand by the owner (CLAUDE.md), so this ships before
 * 043 does. `GET /api/share/today` answers 503 `share_unavailable` in that
 * window and this renders NOTHING — not a disabled button, not an error. A
 * disabled control with no explanation is worse than an absent one: the
 * feature is not broken, it is not built yet, and the trader has no action to
 * take either way.
 *
 * THE COST IS ONE REQUEST PER DASHBOARD LOAD, and it is not wasted: the same
 * response carries the dialog's entire payload — today's existing links, the
 * trader's handle, and the preview. The alternative, a `shareAvailable` prop
 * computed in the RSC page, would move the same query server-side but make the
 * dashboard's own render wait on it, and the dashboard is the screen a trader
 * opens first.
 *
 * `available === null` RENDERS NOTHING TOO, which is the pre-answer state.
 * That means the button fades in rather than appearing instantly, and that is
 * the right trade against the alternative — rendering it optimistically and
 * removing it — which would flash a control that cannot work.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, Share2, X } from 'lucide-react';

import { useModalDialog } from '@/lib/a11y/useModalDialog';
import {
  MAX_PUBLIC_NICKNAME,
  shareSnapshotLines,
  type DailyShareSnapshot,
  type ShareVisibility,
} from '@/lib/share/snapshot';

/** The one `visibility` the UI can currently produce. See the toggles below. */
const ALL_OFF: ShareVisibility = { nickname: false, balance: false };

interface OwnShareWire {
  token: string;
  tradingDay: string;
  visibility: ShareVisibility;
  snapshot: DailyShareSnapshot | null;
  revokedAt: string | null;
  createdAt: string;
}

interface TodayWire {
  available: true;
  day: string;
  nickname: string | null;
  preview: DailyShareSnapshot | null;
  shares: OwnShareWire[];
}

/** The house header-action button — JournalExport's string, byte for byte. */
const ACTION_CLASS =
  'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150 disabled:opacity-40';
const ACTION_STYLE: React.CSSProperties = {
  background: 'var(--color-tg-surface)',
  borderColor: 'var(--color-tg-border)',
  color: 'var(--color-tg-text-2)',
};

/**
 * The one filled control in the dialog — Button.tsx's `primary` variant
 * (turquoise, black text) expressed in this file's idiom.
 *
 * NOT `<Button variant="primary">`: every other control in here is
 * ACTION_CLASS + a style object, and the share row needs the primary and the
 * secondary to agree on height, radius and padding to the pixel. Mixing a
 * shared component with the local pattern in one two-button stack is how those
 * drift apart.
 */
const PRIMARY_STYLE: React.CSSProperties = {
  background: 'var(--color-tg-primary)',
  borderColor: 'var(--color-tg-primary)',
  color: '#000',
};

/** The share sheet's title. Targets that ignore it (Instagram) lose nothing. */
const SHARE_TITLE = 'יום המסחר שלי ב-Reflect';

/**
 * Save a File the browser already holds, without a round trip.
 *
 * The download ANCHOR elsewhere in this dialog streams straight from the URL
 * and is the better thing when there is no Blob in hand. Here there is one —
 * the share path already fetched it — so re-requesting the PNG only to have the
 * browser write it to disk would be a second 150 KB fetch for bytes that are
 * one object URL away.
 */
function saveFile(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  // IN THE DOCUMENT BEFORE `click()`, which is JournalExport's shape byte for
  // byte. A detached anchor is enough in Chromium — measured, by driving this
  // button and watching the download fire either way — so this is NOT load
  // bearing there. It is kept because Firefox has historically ignored a
  // synthetic click on an unattached anchor, and Firefox is precisely a
  // browser this path exists for: `canShare({files})` is false on it
  // everywhere, so every Firefox user who presses "שתף תמונה" lands here.
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Deferred, not immediate: revoking synchronously after `click()` races the
  // browser's own read of the URL in Safari and lands an empty file on disk.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function ShareDayButton() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [data, setData] = useState<TodayWire | null>(null);
  const [open, setOpen] = useState(false);

  /**
   * ONLY THE FIRST ANSWER MAY HIDE THE CONTROL.
   *
   * `available === false` unmounts this whole component, the open dialog with
   * it — and `onChanged` below re-runs `load()` straight after a link is
   * minted. So a refresh that failed used to take the dialog down at the exact
   * moment it had something to show: the link was created, and the trader was
   * dropped back on the dashboard with no link and no error. A transient 401,
   * a 500 or a dropped connection was enough.
   *
   * After the control is up, a failed refresh therefore changes nothing: the
   * last good payload stays on screen and the dialog reports its own failures
   * beside its own buttons, which is where a trader is looking.
   */
  const hide = useCallback(() => {
    setAvailable((prev) => (prev === null ? false : prev));
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/share/today', { signal, cache: 'no-store' });
      if (res.status === 503) {
        hide();
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        // A 401 is a session that expired under an open tab. Treated as
        // unavailable rather than surfaced: the trader's next action will
        // redirect them to /login anyway, and an error beside the greeting
        // about a feature they have not touched is noise.
        hide();
        return;
      }
      setData(body as TodayWire);
      setAvailable(true);
    } catch {
      // Withdrawn or offline. Say nothing and render nothing.
      if (!signal?.aborted) hide();
    }
  }, [hide]);

  useEffect(() => {
    const controller = new AbortController();
    // Fetch-once-on-mount effect, the same shape (and the same disable) as
    // AICoachCard's: the state this sets is the OUTCOME of the request this
    // effect starts, so there is nothing to defer it behind. The abort in the
    // teardown is what keeps a withdrawn request from writing into an
    // unmounted tree.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the result of the fetch started here
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (available !== true || data === null) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={ACTION_CLASS}
        style={ACTION_STYLE}
        title="שתף את יום המסחר הזה בקישור ציבורי"
      >
        <Share2 aria-hidden="true" size={13} />
        שתף את היום
      </button>
      {open && (
        <ShareDayDialog
          initial={data}
          onClose={() => setOpen(false)}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}

// ── The dialog ──────────────────────────────────────────────────────────────

/**
 * Preview, consent, link.
 *
 * PORTALED, AND THE PORTAL IS MANDATORY rather than stylistic: `.page-enter`
 * retains a `transform`, which scopes `position: fixed` to that ancestor's box
 * instead of the viewport. JournalClient's local `Modal` is the shape this
 * copies — there is no shared Modal in this repo — and `useModalDialog`
 * supplies the Escape/focus-trap stack so this dialog cooperates with every
 * other overlay in the app.
 */
function ShareDayDialog({
  initial,
  onClose,
  onChanged,
}: {
  initial: TodayWire;
  onClose: () => void;
  onChanged: () => void;
}) {
  const titleId = useId();
  const { dialogProps } = useModalDialog({
    open: true,
    onClose,
    labelledBy: titleId,
    // Read-first: the preview is the point, so a screen reader should start at
    // the title rather than on the close button.
    initialFocus: 'container',
  });

  const [showNickname, setShowNickname] = useState(false);
  const [nickname, setNickname] = useState(initial.nickname ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The live links for today. A revoked row stays in the response — revocation
  // is a stamp — so the dialog filters rather than expecting the list to shrink.
  const [shares, setShares] = useState(initial.shares.filter((s) => s.revokedAt === null));
  const live = shares[0] ?? null;

  const trimmedNickname = nickname.replace(/\s+/g, ' ').trim();

  // The preview with the toggle applied. The server builds it with
  // `nickname: false` and never puts the handle on the wire unasked, so
  // previewing the name is a local patch of a local copy.
  const preview: DailyShareSnapshot | null =
    initial.preview === null
      ? null
      : { ...initial.preview, nickname: showNickname && trimmedNickname !== '' ? trimmedNickname : null };

  const shareUrl = live === null ? null : `${window.location.origin}/share/${live.token}`;

  /**
   * THE SQUARE, as a File, held ready before the trader asks for it.
   *
   * `navigator.share()` REQUIRES TRANSIENT USER ACTIVATION, and on iOS Safari —
   * which is the entire point of this button — an `await` between the click and
   * the call spends it: fetching the PNG inside the handler and then sharing
   * throws `NotAllowedError` on exactly the platform the feature exists for.
   * The Web Share API takes no promise for `files`, so the only way to call it
   * synchronously from the gesture is to already have the bytes.
   *
   * So the dialog fetches the card once, when the link appears, and the handler
   * finds it waiting. It still falls back to fetching on demand — a trader who
   * clicks before the prefetch lands must not get nothing — and that path is
   * the one that can hit the activation limit, which is why the handler treats
   * a share failure as "download instead" rather than as an error.
   *
   * ONE EXTRA REQUEST, and it is the same URL the download button uses, so the
   * HTTP cache serves that click from memory. The preview `<img>` above fetches
   * the 1200×630; this is the 1080×1080 and they do not collide.
   */
  const imageUrl = live === null ? null : `/share/${live.token}/image?size=square`;
  const imageName = live === null ? null : `reflect-${live.tradingDay}.png`;
  const [cardFile, setCardFile] = useState<File | null>(null);

  useEffect(() => {
    if (imageUrl === null || imageName === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(imageUrl, { signal: controller.signal });
        if (!res.ok) return;
        const blob = await res.blob();
        setCardFile(new File([blob], imageName, { type: 'image/png' }));
      } catch {
        // Left null on purpose. `shareImage` fetches on demand, and a prefetch
        // that failed is not something to tell the trader about.
      }
    })();
    return () => controller.abort();
  }, [imageUrl, imageName]);

  /**
   * The phone's own share sheet — WhatsApp, Instagram, Save to Photos.
   *
   * THE FALLBACK IS A DOWNLOAD, not a message. `canShare({files})` is false on
   * every desktop browser and on Firefox everywhere, and a trader there has
   * asked for the image, not for an explanation — so they get the image. The
   * secondary button below says the same thing in words for anyone who wants it
   * explicitly.
   */
  async function shareImage() {
    if (imageUrl === null || imageName === null) return;
    setBusy(true);
    setMessage(null);
    try {
      let file = cardFile;
      if (file === null) {
        const res = await fetch(imageUrl);
        if (!res.ok) {
          setMessage('לא הצלחנו להכין את התמונה.');
          return;
        }
        file = new File([await res.blob()], imageName, { type: 'image/png' });
        setCardFile(file);
      }

      // `canShare` is absent entirely on older browsers, so this is a typeof
      // check and not a truthiness one — and it is asked about THIS file,
      // because a browser can support sharing text and refuse PNGs.
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: SHARE_TITLE });
        return;
      }

      saveFile(file);
      setMessage('הדפדפן הזה לא תומך בשיתוף תמונה — הורדנו אותה במקום.');
    } catch (err) {
      // DISMISSING THE SHEET IS NOT A FAILURE. Both Safari and Chrome reject
      // with AbortError when the trader taps outside it, and an error message
      // for "changed my mind" is noise beside a button they just dismissed.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[share] share image failed', err);
      setMessage('לא הצלחנו לשתף את התמונה.');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/share/today', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visibility: { ...ALL_OFF, nickname: showNickname && trimmedNickname !== '' },
          // Only when it changed, so a dialog opened and closed does not
          // rewrite the profile row for nothing.
          ...(trimmedNickname !== (initial.nickname ?? '') ? { nickname: trimmedNickname || null } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.share) {
        console.error('[share] create failed', res.status, body);
        setMessage(body?.error === 'share_unavailable'
          ? 'השיתוף אינו זמין עדיין.'
          : `לא הצלחנו ליצור קישור (קוד ${res.status})`);
        return;
      }
      setShares([body.share as OwnShareWire]);
      setMessage(null);
      onChanged();
    } catch (err) {
      console.error('[share] create request failed', err);
      setMessage('לא הצלחנו ליצור קישור.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (live === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/share/${live.token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revoked: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        console.error('[share] revoke failed', res.status, body);
        setMessage(`לא הצלחנו לבטל את הקישור (קוד ${res.status})`);
        return;
      }
      setShares([]);
      setCopied(false);
      setMessage('הקישור בוטל.');
      onChanged();
    } catch (err) {
      console.error('[share] revoke request failed', err);
      setMessage('לא הצלחנו לבטל את הקישור.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (shareUrl === null) return;
    // THE FIRST CLIPBOARD USE IN THIS CODEBASE, so it owns its own feature
    // detection: `navigator.clipboard` is undefined on an insecure origin, and
    // an unguarded call there throws a TypeError rather than failing politely.
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setMessage('הקישור הועתק.');
    } catch {
      setCopied(false);
      setMessage('לא הצלחנו להעתיק. אפשר לסמן ולהעתיק ידנית.');
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        {...dialogProps}
        dir="rtl"
        className="w-full max-w-md mx-auto max-h-[90dvh] overflow-y-auto rounded-2xl p-5 flex flex-col gap-4 my-auto"
        style={{
          background: 'var(--color-tg-surface)',
          border: '1px solid var(--color-tg-border)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-bold" style={{ color: 'var(--color-tg-text)' }}>
            שתף את היום
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגור"
            // `relative` IS LOAD-BEARING, not tidiness. `.hit-40::after` is an
            // absolutely-positioned 40×40 touch target, so the element has to
            // be its own positioning context — globals.css says so where the
            // utility is defined, and the other 23 call sites all pair the two.
            // Without it the pseudo-element resolved against the nearest
            // positioned ancestor, which here is the `fixed inset-0` backdrop:
            // `width: max(100%, 40px)` then measured the VIEWPORT, laying an
            // invisible full-screen close target over the dialog. Every control
            // underneath it closed the dialog instead of doing its own job —
            // "צור קישור" included, which is why the button looked like it
            // bounced back to the dashboard without minting a link.
            className="hit-40 relative shrink-0"
            style={{ color: 'var(--color-tg-muted)' }}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        {/* ── What will be published ──────────────────────────────────────── */}
        {/* TWO PREVIEWS, AND WHICH ONE SHOWS IS NOT CosmETIC.
            Before the link exists there is no token, so there is no image to
            render — the lines are the only honest preview available, and they
            come from the same builder the mint will use.
            Once the link exists, the IMAGE is the preview, because the image
            is what the trader is actually about to send: it is the bytes a
            social platform will unfurl and the bytes the download button
            produces. Showing the text summary at that point would be
            previewing a different artefact from the one being shared. */}
        {live === null ? (
          <div
            className="rounded-xl p-3 flex flex-col gap-1"
            style={{ background: 'var(--color-tg-surface-2)', border: '1px solid var(--color-tg-border)' }}
          >
            {preview === null ? (
              <p className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>
                לא הצלחנו לבנות תצוגה מקדימה.
              </p>
            ) : (
              shareSnapshotLines(preview).map((line, i) => (
                <p
                  key={`${i}-${line}`}
                  // Every line can contain a figure or a fraction, and bidi
                  // reorders both — "4/5" becomes "5/4" in an RTL run, which
                  // inverts a discipline claim invisibly. `isolate` per line is
                  // the cheap correct thing here; the public card does the same
                  // per value.
                  style={{
                    fontSize: 12,
                    unicodeBidi: 'isolate',
                    color: i === 0 ? 'var(--color-tg-text)' : 'var(--color-tg-muted)',
                    fontWeight: i === 0 ? 700 : 400,
                  }}
                >
                  {line}
                </p>
              ))
            )}
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- deliberate: next/image would route this through the optimizer to re-encode a PNG we already render at exactly one size, adding a per-transform cost for a ~110 KB image in a dialog the trader opened on purpose. It would also be optimising a URL that 404s the moment the link is revoked.
          <img
            // The 1200×630 render — the same bytes an unfurler gets, not a
            // reconstruction of it in DOM. `aspect-ratio` plus the intrinsic
            // width/height reserve the box before the PNG arrives, so the
            // dialog does not jump when it does.
            src={`/share/${live.token}/image`}
            width={1200}
            height={630}
            alt="תצוגה מקדימה של כרטיס היום"
            className="w-full h-auto rounded-xl"
            style={{
              aspectRatio: '1200 / 630',
              border: '1px solid var(--color-tg-border)',
              background: 'var(--color-tg-surface-2)',
            }}
          />
        )}

        {/* ── Consent ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1">
          <ShareToggle
            label="הצג את הכינוי שלי"
            pressed={showNickname}
            onClick={() => setShowNickname((v) => !v)}
            disabled={trimmedNickname === ''}
          />
          {/* Inline handle editing, as the ticket asks. Shown when there is no
              handle yet — the toggle above is disabled until there is one,
              because consenting to show a name you have not chosen is not a
              state worth having. */}
          {initial.nickname === null && (
            <label className="flex flex-col gap-1 px-1 pb-1">
              <span className="text-[11px]" style={{ color: 'var(--color-tg-muted)' }}>
                הכינוי הציבורי שלך — נשמר בפרופיל, ולא השם שאיתו נרשמת
              </span>
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={MAX_PUBLIC_NICKNAME}
                placeholder="לדוגמה: סוחר ES"
                className="rounded-lg px-2.5 py-1.5 text-sm"
                style={{
                  background: 'var(--color-tg-surface-2)',
                  border: '1px solid var(--color-tg-border)',
                  color: 'var(--color-tg-text)',
                }}
              />
            </label>
          )}

          {/* THE ACCOUNTS TOGGLE IS GONE, and its absence is the honest render
              of what the card now does: account names are ALWAYS published
              (Imri, 28.10). A disabled switch reading "הצג שמות תיקים" beside
              a card that shows them regardless would tell the trader the
              opposite of the truth, which is worse than saying nothing — so
              the line below says it in words instead, where the preview the
              trader is looking at already lists the names.

              Balance keeps its placeholder: nothing publishes it. */}
          <p className="px-1 text-[11px]" style={{ color: 'var(--color-tg-muted)' }}>
            שמות התיקים שלך מופיעים על הכרטיס, כפי שהם בתצוגה המקדימה למעלה.
          </p>
          <ShareToggle label="הצג יתרה" pressed={false} disabled hint="בקרוב" />
        </div>

        {/* ── The link ────────────────────────────────────────────────────── */}
        {shareUrl === null ? (
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy}
            className={ACTION_CLASS}
            style={{ ...ACTION_STYLE, justifyContent: 'center', padding: '10px 12px' }}
          >
            צור קישור
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareUrl}
                dir="ltr"
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 rounded-lg px-2.5 py-1.5 text-xs"
                style={{
                  background: 'var(--color-tg-surface-2)',
                  border: '1px solid var(--color-tg-border)',
                  color: 'var(--color-tg-text)',
                }}
              />
              <button
                type="button"
                onClick={() => void copy()}
                className={ACTION_CLASS}
                style={ACTION_STYLE}
                aria-label="העתק את הקישור"
              >
                {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
                העתק קישור
              </button>
            </div>

            {/* THE SQUARE, NOT THE ONE ABOVE, for both of these. The preview is
                1200×630 because that is what unfurls; what a trader does with
                the card in their hand is post it to Instagram or a status,
                where a landscape crop loses the number. Both come from the same
                renderer.

                SHARING IS THE PRIMARY ACTION AND DOWNLOADING IS NOT, because
                this dialog is opened on a phone far more often than on a
                desktop, and on a phone "download" ends the job halfway: the
                trader still has to leave Reflect, open Photos, open WhatsApp
                and find the file. The sheet is the one tap that reaches the app
                they meant. The download stays because it is the only thing that
                works when the sheet is not there. */}
            <button
              type="button"
              onClick={() => void shareImage()}
              disabled={busy}
              className={ACTION_CLASS}
              style={{ ...PRIMARY_STYLE, justifyContent: 'center', padding: '10px 12px' }}
            >
              <Share2 aria-hidden="true" size={13} />
              שתף תמונה
            </button>

            {/* A PLAIN ANCHOR WITH `download`, not JournalExport's
                blob-and-synthetic-anchor: that pattern exists because the CSV
                is built in the browser and has no URL. This has a URL, it is
                same-origin, and letting the browser stream it straight to
                disk avoids holding a 150 KB PNG in memory to hand it back to
                the same browser. The filename carries the day so a folder of
                these is sortable. */}
            <a
              href={`/share/${live.token}/image?size=square`}
              download={`reflect-${live.tradingDay}.png`}
              className={ACTION_CLASS}
              style={{ ...ACTION_STYLE, justifyContent: 'center', padding: '8px 12px' }}
            >
              <Download aria-hidden="true" size={13} />
              הורד תמונה
            </a>

            <button
              type="button"
              onClick={() => void revoke()}
              disabled={busy}
              className="text-xs font-medium underline self-start"
              style={{ color: 'var(--color-tg-muted)' }}
            >
              בטל קישור
            </button>
          </div>
        )}

        {/* WHAT REVOCATION ACTUALLY DOES, said plainly. Migration 043 and
            REF-125 §7: it stops future visits to the page. It cannot retract a
            copy somebody already opened, and once the card has an image
            (stage 3) it will not unpublish one a social platform has cached.
            A revoke button that implied otherwise would be the one piece of
            dishonest copy in the feature. */}
        <p className="text-[11px] leading-snug" style={{ color: 'var(--color-tg-muted)' }}>
          הקישור פתוח לכל מי שמקבל אותו, ואין לו תפוגה. ביטול הקישור עוצר כניסות חדשות לעמוד —
          הוא לא מוחק צילום מסך או העתק שמישהו כבר פתח. הנתונים בקישור קפואים לרגע היצירה:
          שינוי של התצוגה כאן יחול על קישורים חדשים בלבד.
        </p>

        {/* Polite, beside the control — BrokerSyncButton's pattern, which is
            this repo's substitute for a toast system (there is none). */}
        <div aria-live="polite" className="text-[11px]" style={{ color: 'var(--color-tg-text-2)' }}>
          {message}
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * A toggle row with RTL-correct geometry.
 *
 * NOT `components/ui/Toggle.tsx`, which has the right `role="switch"` /
 * `aria-checked` semantics and zero call sites — and whose knob is positioned
 * with `left-0.5` + `translateX(20px)`, both PHYSICAL, so in this `dir="rtl"`
 * dialog it would travel the wrong way. The geometry below is
 * AccessibilityWidget's `insetInlineStart`, which is the logical property and
 * the only version of this in the repo that works in both directions.
 *
 * `role="switch"` + `aria-checked` from Toggle.tsx rather than
 * AccessibilityWidget's `aria-pressed`: this is a setting that is on or off,
 * which is what a switch is, and the widget's rows are buttons that do things.
 */
function ShareToggle({
  label,
  pressed,
  onClick,
  disabled = false,
  hint,
}: {
  label: string;
  pressed: boolean;
  onClick?: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={pressed}
      disabled={disabled}
      onClick={onClick}
      className="w-full flex items-center justify-between gap-3 px-1 py-2 text-sm disabled:opacity-40"
      style={{ color: 'var(--color-tg-text-2)' }}
    >
      <span className="flex items-baseline gap-2 min-w-0">
        <span className="truncate">{label}</span>
        {hint && (
          <span className="text-[10px] shrink-0" style={{ color: 'var(--color-tg-muted)' }}>
            {hint}
          </span>
        )}
      </span>
      <span
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
        style={{ background: pressed ? 'var(--color-tg-primary)' : 'var(--color-tg-border)' }}
        aria-hidden
      >
        <span
          className="absolute h-3.5 w-3.5 rounded-full bg-white transition-all"
          style={{ insetInlineStart: pressed ? 'calc(100% - 16px)' : '2px' }}
        />
      </span>
    </button>
  );
}
