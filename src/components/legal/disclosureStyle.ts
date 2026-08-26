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
 *   - **`text-xs`, which is 14px here, not 12.** globals.css bumps the whole
 *     `text-*` scale one step. This is the floor: anything smaller stops being
 *     "visible and legible", which is the standard these texts have to meet.
 *   - **`--color-tg-disclosure`.** Not `--color-tg-muted`: on dark that token
 *     is #ffffff, i.e. brighter than body text. See the token's own comment.
 *
 * Measured on the landing background: 8.86:1 at 14px — past AAA (7:1) for
 * normal text, so the alpha did not need loosening when the size came down.
 * If it is ever reduced further, re-measure: AA at this size is 4.5:1.
 */
export const DISCLOSURE_TEXT_CLASS = 'text-xs font-normal leading-relaxed';

/** Paired with the class above; kept separate because it is a CSS variable. */
export const DISCLOSURE_TEXT_STYLE: React.CSSProperties = {
  color: 'var(--color-tg-disclosure)',
};

/**
 * Reading measure. Left to run the full width of a footer, these paragraphs
 * span ~140 characters a line, which is what made them read as a content block
 * rather than as fine print — long measures look like body text regardless of
 * how small the type is.
 *
 * 50ch resolves to a 445px box at 14px, which measures 68–71 characters on a
 * full line — inside the 65–75 target, and close enough between the two
 * scripts (70 Hebrew, 69 Latin) that one box serves both.
 *
 * Measure by counting characters on the *first* line, not by averaging the
 * paragraph: a short final line drags a whole-paragraph average well below
 * the true measure, which is what a two-line disclosure is mostly made of.
 * And do not infer the figure from the `ch` value — `ch` is the width of
 * "0", which matches neither script. Re-measure if the size or family changes.
 */
export const DISCLOSURE_MEASURE = 'max-w-[50ch]';

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
