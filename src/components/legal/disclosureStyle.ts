/**
 * The one place the visual weight of every legal disclosure is decided.
 *
 * These texts are mandatory and must stay legible, but they are not the page's
 * argument — so they read as fine print that a person can actually read, rather
 * than as content competing with the copy around them.
 *
 * Three things had to be set explicitly, none of which are defaults here:
 *
 *   - **Weight 400.** There was never a `font-bold` to remove: globals.css sets
 *     `body { font-weight: 500 }`, so everything inherits medium, and inside the
 *     app shell `.sidebar-motion .text-tg-muted` pushes muted text to 600.
 *     `font-normal` is what actually steps the text back, and it beats both
 *     (the shell rule lives in @layer components so utilities win).
 *   - **`text-sm`, which is 16px here, not 14.** globals.css bumps the whole
 *     `text-*` scale one step, so the disclosures were rendering at 18px —
 *     level with the footer tagline. 16px sits a step under the 18/20px body
 *     copy without dropping to the unreadable end of the scale.
 *   - **`--color-tg-disclosure`.** Not `--color-tg-muted`: on dark that token
 *     is #ffffff, i.e. brighter than body text. See the token's own comment.
 *
 * Measured result on the landing background: ~8.4:1, comfortably past WCAG AA
 * for normal text. Dimmer than the copy around it, never near-invisible.
 */
export const DISCLOSURE_TEXT_CLASS = 'text-sm font-normal leading-relaxed';

/** Paired with the class above; kept separate because it is a CSS variable. */
export const DISCLOSURE_TEXT_STYLE: React.CSSProperties = {
  color: 'var(--color-tg-disclosure)',
};

/**
 * The dedicated /risk-disclosure page is the one place these texts *are* the
 * content, so they render at body size and in the normal text colour there.
 * Everywhere else they are fine print.
 */
export type DisclosureVariant = 'footnote' | 'page';

export function disclosureTextProps(variant: DisclosureVariant = 'footnote') {
  return variant === 'page'
    ? {
        className: 'text-base font-normal leading-relaxed',
        style: { color: 'var(--color-tg-text)' } as React.CSSProperties,
      }
    : { className: DISCLOSURE_TEXT_CLASS, style: DISCLOSURE_TEXT_STYLE };
}
