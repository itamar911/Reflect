/**
 * The one piece of bidi the share card has to do itself (REF-125 Stage 3).
 *
 *
 * WHY THIS FILE EXISTS, AND WHY THE EARLIER CLAIM WAS WRONG
 * ---------------------------------------------------------
 *
 * `cardImage.tsx` used to assert, in a docblock, that "intra-run Hebrew
 * ordering IS correct — satori reverses within a run". IT DOES NOT. The claim
 * came from reading satori's source rather than from looking at a PNG, and the
 * first batch of approval renders shows every Hebrew string on the card
 * letter-reversed: `תוצאת היום` rasterised as `םויה תאצות`.
 *
 * satori has no bidi engine at all. It lays glyphs out in LOGICAL order,
 * left to right, which is the correct visual order for Latin and the exact
 * reverse of the correct visual order for Hebrew.
 *
 * The fix for the card as a whole is not this function — it is that THE CARD IS
 * NOW ENGLISH ONLY. Every label, the provenance line, the tagline and the
 * domain are Latin, so there is no RTL text on the image to get wrong. The
 * Hebrew lives on `/share/[token]`, which is a real browser page with a real
 * bidi implementation and needs none of this.
 *
 * ONE STRING SURVIVES: the trader's chosen nickname, which is user data and may
 * be Hebrew. That is what this reorders.
 *
 *
 * WHAT THIS IS NOT
 * ----------------
 *
 * NOT an implementation of UAX #9. It implements the two rules that a short
 * display name actually exercises — base direction from the first strong
 * character (P2/P3), and visual reordering of directional runs (L2) — and
 * ignores explicit embedding controls, bracket pairing and mirrored glyphs. A
 * nickname is bounded at MAX_PUBLIC_NICKNAME (24) characters and is a name, not
 * a paragraph. Reaching for a full bidi dependency to lay out twenty-four
 * characters on one PNG route would be the wrong trade.
 *
 * It is covered by assertions in `scripts/share-card-check.ts`, which is the
 * part that matters: this is the kind of code that looks right and is wrong,
 * and the only reason the bug it fixes reached a render is that nobody had
 * written a test that could fail.
 */

/**
 * Strong RTL: Hebrew, Arabic, Syriac, Thaana, and the Arabic/Hebrew
 * presentation-form blocks. Not a complete set of RTL scripts — it is the set a
 * Reflect trader plausibly types a name in.
 */
const RTL_STRONG =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/**
 * Strong LTR: Latin (including the accented ranges), Greek, Cyrillic.
 *
 * DIGITS ARE DELIBERATELY NOT HERE. They are not strong — a name that is only
 * digits takes its direction from its surroundings, not from itself — but they
 * DO lay out left to right inside an RTL phrase (UAX #9 calls them European
 * numbers). So they are excluded from the base-direction test below and
 * included in the "do not reverse internally" test. `2026` inside a Hebrew
 * handle must stay `2026` and not become `6202`, which is exactly the bug a
 * single whole-string reverse would introduce.
 */
const LTR_STRONG = /[A-Za-z\u00C0-\u02AF\u0370-\u03FF\u0400-\u04FF]/;

/** Latin, Greek, Cyrillic or a digit: a run that must keep its own order. */
const LTR_OR_NUMBER = /[A-Za-z\u00C0-\u02AF\u0370-\u03FF\u0400-\u04FF0-9]/;

type RunClass = 'rtl' | 'ltr' | 'neutral';

function classify(grapheme: string): RunClass {
  if (RTL_STRONG.test(grapheme)) return 'rtl';
  if (LTR_OR_NUMBER.test(grapheme)) return 'ltr';
  return 'neutral';
}

/**
 * Grapheme clusters, not code units.
 *
 * REVERSING BY CODE UNIT IS TWO BUGS AT ONCE. It splits surrogate pairs into
 * lone halves (any astral character — and a nickname is free-text, so one can
 * arrive), and it moves a combining mark in front of the base it modifies, so
 * Hebrew written with niqqud comes apart. `Intl.Segmenter` is in every runtime
 * this code runs on (Node 18+, and the image route is pinned to `nodejs`).
 */
function graphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter('he', { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** True if the string holds any strong RTL character. */
export function hasRtl(text: string): boolean {
  return RTL_STRONG.test(text);
}

/**
 * Base direction, by UAX #9's first-strong rule: the first character that is
 * strongly LTR or strongly RTL decides, and a string with neither is LTR.
 */
function baseIsRtl(text: string): boolean {
  for (const g of graphemes(text)) {
    if (RTL_STRONG.test(g)) return true;
    if (LTR_STRONG.test(g)) return false;
  }
  return false;
}

/**
 * Reorder a string from LOGICAL order into the VISUAL order satori will draw.
 *
 * The return value is only correct when painted by a renderer that has no bidi
 * of its own. NEVER put it in the DOM — a browser would apply its own bidi on
 * top and reverse it right back, which is why this is in `lib/share/` beside
 * the satori tree and not in a general string utility.
 *
 * English in, same English out: the first branch returns the input untouched
 * when there is no RTL character in it, so every Latin label on the card goes
 * through this unchanged (and most call sites never need to think about it).
 */
export function toVisualOrder(text: string): string {
  if (!RTL_STRONG.test(text)) return text;

  // Split into maximal same-class runs, keeping grapheme clusters whole.
  const runs: Array<{ cls: RunClass; parts: string[] }> = [];
  for (const g of graphemes(text)) {
    const cls = classify(g);
    const last = runs[runs.length - 1];
    if (last && last.cls === cls) last.parts.push(g);
    else runs.push({ cls, parts: [g] });
  }

  const rtlBase = baseIsRtl(text);

  // L2, reduced to the one embedding level this needs: in an RTL paragraph the
  // runs are laid out right to left, so emitting them in reverse order gives
  // the left-to-right sequence a bidi-less renderer should paint. LTR runs keep
  // their internal order at any level — that is the whole point of the level
  // distinction, and it is what keeps `Nasdaq` and `2026` readable inside a
  // Hebrew name.
  const ordered = rtlBase ? [...runs].reverse() : runs;

  return ordered
    .map(({ cls, parts }) => {
      if (cls === 'ltr') return parts.join('');
      // RTL runs always reverse. Neutral runs (spaces, punctuation) reverse
      // only when the paragraph does, so that a trailing `"` on a Hebrew name
      // lands on the correct side.
      if (cls === 'rtl' || rtlBase) return [...parts].reverse().join('');
      return parts.join('');
    })
    .join('');
}
