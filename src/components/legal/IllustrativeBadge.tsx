import { Info } from 'lucide-react';
import { ILLUSTRATIVE_LABEL } from './disclosureText';

/**
 * Marks a visual as an illustration rather than a real trader's real results.
 *
 * Every figure on the landing page is hand-authored marketing fixture data. Left
 * unlabelled, those numbers read as performance claims, which is a far heavier
 * disclosure burden than simply saying the picture is illustrative — so every
 * visual that shows a number wears one of these.
 *
 * Deliberately NOT small grey type: it is 16px in the primary text colour on a
 * tinted pill, i.e. within touching distance of the page's own reading copy,
 * because "easily visible, same or similar style and size as the primary
 * content" is the actual requirement being satisfied here. It matches the live
 * demo section's existing "נתונים לדוגמה" treatment.
 *
 * It is real text, not aria-hidden: the mocks it labels are aria-hidden
 * illustrations, so this line is the only part of them a screen reader meets —
 * which is exactly the part that has to reach everyone.
 */
export function IllustrativeBadge({ className = '' }: { className?: string }) {
  return (
    <span
      dir="rtl"
      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-base font-semibold ${className}`}
      style={{
        color: 'var(--color-tg-text)',
        background: 'rgba(0,210,210,0.09)',
        border: '1px solid rgba(0,210,210,0.3)',
      }}
    >
      <Info aria-hidden="true" size={16} className="shrink-0" style={{ color: '#00d2d2' }} />
      {ILLUSTRATIVE_LABEL}
    </span>
  );
}

/**
 * Wrapper form: the visual plus its label, centred underneath. Use this when a
 * visual has no natural caption slot of its own to hang the badge on.
 */
export function IllustrativeVisual({
  children,
  className = '',
  align = 'center',
}: {
  children: React.ReactNode;
  className?: string;
  align?: 'center' | 'start';
}) {
  return (
    <div className={`flex flex-col gap-3 ${align === 'center' ? 'items-center' : 'items-start'} ${className}`}>
      {children}
      <IllustrativeBadge />
    </div>
  );
}
