import { NINJATRADER_ATTRIBUTION } from './disclosureText';

/**
 * Trademark attribution for the NinjaTrader platform. Required prominently on
 * every page that mentions NinjaTrader — drop this component onto any such
 * page rather than retyping the sentence, so the wording can never drift.
 *
 * English only and dir="ltr" on purpose: it is a trademark notice in its
 * prescribed language, not copy to be localised.
 *
 * House rules that go with it, enforced anywhere the name is written:
 *   - "NinjaTrader" — one word, capital N, capital T. Never "Ninja Trader",
 *     "ninjatrader", or "NinjaTRADER".
 *   - "Kinetick" — capital K.
 *   - Never imply approval, certification, premium status, endorsement or
 *     partnership, and never reference NinjaTrader Clearing, LLC.
 *   - No product name, URL, route slug, meta title or social handle may
 *     contain a NinjaTrader trademark.
 */
export function NinjaTraderAttribution({ className = '' }: { className?: string }) {
  return (
    <p
      dir="ltr"
      className={`text-base leading-relaxed text-start ${className}`}
      style={{ color: 'var(--color-tg-text)' }}
    >
      {NINJATRADER_ATTRIBUTION}
    </p>
  );
}
