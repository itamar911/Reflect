/**
 * What Reflect cannot do for this trader, on a page (REF-112 §5).
 *
 * NO `'use client'` AND NO HOOKS, deliberately. /accounts renders it from a
 * server component and the dashboard renders it from inside a client one, and
 * a component with neither a directive nor state works in both — marking it
 * would pull it into the client bundle for a page that needs nothing of the
 * sort, and making it server-only would mean the dashboard could not import
 * it at all.
 *
 * IT IS THE SAME SENTENCES THE SYNC PANEL SHOWS. lib/tradovate/notices.ts owns
 * the copy; this owns how it looks. A trader who sees "החיבור לברוקר פג" on
 * the dashboard and something slightly different in the panel would reasonably
 * conclude they are two problems.
 *
 * `role="alert"` AND NOT `aria-live="polite"`, which is the opposite of
 * BrokerSyncButton's choice and for the stated reason: that one reports the
 * outcome of something the trader just asked for and must not interrupt a
 * screen reader on every page entry. This is a standing condition that was
 * already true when the page opened, and it is the reason the list under it
 * is short or empty.
 */

import { AlertTriangle } from 'lucide-react';

import { noticeLines, type BrokerNotice } from '@/lib/tradovate/notices';

/**
 * One line per notice, or nothing at all.
 *
 * RENDERS NOTHING FOR AN EMPTY LIST rather than an empty box — the ordinary
 * case is no notices, and a bordered strip with nothing in it is a thing a
 * trader learns to ignore before the day it matters.
 */
export default function BrokerNotices({ notices }: { notices: readonly BrokerNotice[] }) {
  const lines = noticeLines(notices);
  if (lines.length === 0) return null;

  return (
    <div
      dir="rtl"
      role="alert"
      className="flex items-start gap-2 rounded-xl border px-3 py-2.5"
      style={{
        background: 'var(--color-tg-surface)',
        borderColor: 'var(--color-tg-border)',
      }}
    >
      <AlertTriangle
        aria-hidden="true"
        size={15}
        className="shrink-0 mt-0.5"
        style={{ color: 'var(--color-tg-warning)' }}
      />
      <div className="flex flex-col gap-1 min-w-0">
        {lines.map((line) => (
          <p key={line} className="text-xs leading-snug" style={{ color: 'var(--color-tg-text)' }}>
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
