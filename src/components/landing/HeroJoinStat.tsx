/**
 * Registered Reflect accounts, cumulative. Update as the real number grows.
 *
 * Three things about this figure are deliberate and should not be casually
 * changed back:
 *
 *   - It is cumulative, with no timeframe. The line used to read "בחודש
 *     האחרון", which is a time-bound claim that a hardcoded constant starts
 *     falsifying the day after it is written. A cumulative total only ever
 *     understates itself, which is the safe direction to be wrong in.
 *   - It counts *registrations*, and the copy says exactly that ("נרשמו").
 *     Signups, trial starts and paying customers are three different numbers;
 *     "traders joined" quietly claimed the strongest of the three while
 *     counting the weakest.
 *   - **It is presented as a static figure, not as live data.** This used to
 *     sit behind a pulsing "live" dot and count up from zero when scrolled
 *     into view, which told the reader it was a real-time reading of the
 *     database. It is a constant that changes only when someone edits this
 *     file, so the animation was asserting something untrue about the number's
 *     provenance. The dot and the count-up are gone; the figure stays.
 *
 * If this is ever wired to a real count, the definition has to be settled
 * first — registrations, confirmed accounts and active accounts are three
 * different figures, and a COUNT(*) silently picks one and makes it look
 * authoritative. An anonymous read of profiles is also blocked by RLS, so it
 * would mean a service-role query on the most-hit public route. Only then does
 * a live treatment become honest.
 *
 * Removing the animation removed the last hook here, so this is no longer a
 * client component.
 */
const REGISTERED_TRADERS = 147;

export function HeroJoinStat() {
  return (
    <span
      className="inline-flex items-center gap-2.5 rounded-full px-4 py-1.5 text-sm text-tg-muted"
      style={{
        background: 'rgba(0, 210, 210, 0.07)',
        border: '1px solid rgba(0, 210, 210, 0.25)',
      }}
    >
      <span
        className="text-base font-extrabold"
        style={{
          color: '#00d2d2',
          // LTR-isolated so the "+" stays glued to the left of the digits
          // inside the RTL line, rather than being reordered to its right.
          fontVariantNumeric: 'tabular-nums',
          direction: 'ltr',
          unicodeBidi: 'isolate',
        }}
      >
        +{REGISTERED_TRADERS}
      </span>
      סוחרים נרשמו ל-Reflect
    </span>
  );
}
