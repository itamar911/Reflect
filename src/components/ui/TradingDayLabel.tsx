/**
 * "יום מסחר 27.10" — the name of the day a surface is showing (REF-125 item 4).
 *
 * ONE COMPONENT BECAUSE THE WHOLE POINT IS THAT THE SURFACES AGREE. The
 * dashboard header and the trade form's day panel both name a day, and before
 * this ticket they named DIFFERENT days from the same trades (investigation
 * §2.2). A shared label is the visible half of that fix: if the two ever drift
 * apart again, they drift apart in one file.
 *
 * THE TOOLTIP IS THE NATIVE `title`, which is this repo's tooltip — see
 * BrokerSyncButton and the two gauge cards on the dashboard. A hover-card
 * component would be the larger change and would still have to answer for
 * touch, where `title` and a custom popover are equally invisible; the label
 * itself therefore has to be legible with no tooltip at all, which is why it
 * carries the date rather than only the words.
 *
 * NOT A `<time>` ELEMENT. `datetime` on a `<time>` is a machine-readable
 * instant or date, and a trading day is neither: "2026-10-27" as a `datetime`
 * would assert the calendar date, which is precisely the claim this label
 * exists to stop a reader making.
 */
import { tradingDayLabel, tradingDayWindowNote, type TradingDay } from '@/lib/tradingDay';

export default function TradingDayLabel({
  day,
  color,
  fontSize = 11,
}: {
  day: TradingDay;
  /** Inherited from the surface — this sits in a header whose muted tone varies. */
  color?: string;
  fontSize?: number;
}) {
  const label = tradingDayLabel(day);
  if (label === '') return null;

  return (
    <span
      dir="rtl"
      title={tradingDayWindowNote(day)}
      style={{
        fontSize,
        fontWeight: 600,
        letterSpacing: '0.04em',
        color,
        // `help` and not `default`: the cursor is the only affordance telling a
        // mouse user there is a sentence behind this, and the label is three
        // words that otherwise look inert.
        cursor: 'help',
        // The label is one unit — "יום מסחר" must never wrap away from its date.
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
