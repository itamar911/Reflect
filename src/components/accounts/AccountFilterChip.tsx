import Link from 'next/link';
import { Filter } from 'lucide-react';

/**
 * "מציג: <name> · הצג הכל" — the one thing a filtered page must never be
 * without (REF-110 Stage 5).
 *
 * A SERVER COMPONENT. It has no state: the filter lives in the URL, so
 * clearing it is a link to the same path without the parameter, and a link
 * needs no client bundle.
 *
 * WHY IT IS NOT OPTIONAL CHROME. Every page that honours `?account=` is
 * showing the trader a subset of their own trades, and the figures on it —
 * the win rate, the P&L, the open/closed counts — are all smaller than the
 * ones they saw yesterday. Without this line the only honest reading of that
 * page is "I have lost trades". The chip is the difference between a filter
 * and a bug report.
 *
 * The clear link is part of the chip rather than a separate control for the
 * same reason: the way out has to be in the same glance as the way in.
 */
export default function AccountFilterChip({ label, clearHref }: {
  /** `nickname ?? display_name`. Rendered to the trader, under their own RLS,
   *  and this is the only kind of place it is ever allowed to appear — see
   *  the privacy note on lib/portfolios/read.ts. */
  label: string;
  /** The same route with no `?account=`. */
  clearHref: string;
}) {
  return (
    <div
      dir="rtl"
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold self-start"
      style={{
        background: 'rgba(0,210,210,0.10)',
        border: '1px solid rgba(0,210,210,0.25)',
        color: 'var(--color-tg-text)',
      }}
    >
      <Filter aria-hidden="true" size={13} color="#00d2d2" />
      <span className="truncate" style={{ maxWidth: 220 }}>מציג: {label}</span>
      <span aria-hidden style={{ color: 'var(--color-tg-muted)' }}>·</span>
      <Link href={clearHref} className="font-bold" style={{ color: '#00d2d2' }}>
        הצג הכל
      </Link>
    </div>
  );
}
