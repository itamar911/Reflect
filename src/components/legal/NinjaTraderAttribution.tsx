import { NINJATRADER_ATTRIBUTION } from './disclosureText';
import { disclosureTextProps, type DisclosureVariant } from './disclosureStyle';

/**
 * Trademark attribution for the NinjaTrader platform. Required on every page
 * that mentions NinjaTrader.
 *
 * It is rendered from the site footer (see FooterDisclosures), which every
 * route mounts — so the requirement is met on every page at once, including
 * any future page that names the platform. Drop this component in directly
 * only on a page that has no footer of its own; /risk-disclosure is the one
 * such page today.
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
export function NinjaTraderAttribution({
  className = '',
  variant = 'footnote',
}: {
  className?: string;
  variant?: DisclosureVariant;
}) {
  const text = disclosureTextProps(variant);

  return (
    <p dir="ltr" style={text.style} className={`${text.className} text-start ${className}`}>
      {NINJATRADER_ATTRIBUTION}
    </p>
  );
}
