/**
 * How wide a string will actually be, in the font that will actually draw it.
 *
 * SERVER ONLY, and satori-only.
 *
 *
 * WHY THIS EXISTS: SATORI CANNOT SHRINK TEXT TO FIT
 * -------------------------------------------------
 *
 * There is no `text-overflow`, no auto-sizing, and no way to measure a string
 * before layout. A number set too large for its column does not ellipsise and
 * does not scale — it WRAPS, and if it cannot wrap it overflows and collides
 * with whatever is beside it. The hero P&L is the longest string on the card
 * and its length is not bounded by anything we control: `-$124,875.50` is two
 * characters longer than `+$1,240.50`, and a trader's worst day is exactly the
 * day the string is longest.
 *
 * The previous version of this file handled that with hand-guessed steps —
 * "drop to 84% past 10 characters, 72% past 13". Those numbers were estimated
 * rather than measured, and the first render after the redesign proved them
 * wrong: `+$1,240.50` at the full 120px needed 643px in a 536px column, so the
 * `+` wrapped onto its own line and the label above it was pushed clear out of
 * the card and over the header. A LENGTH IS NOT A WIDTH — `1` and `,` are not
 * the same number of pixels — and the only way to stop guessing is to read the
 * advance widths out of the font the text is set in.
 *
 * So this parses `head`, `hhea`, `hmtx` and `cmap` out of the committed TTF and
 * sums real advances. It is ~80 lines to never think about this again, and it
 * is checked against reality by `scripts/share-card-check.ts`, which asserts
 * that every fixture amount fits the column it is rendered into.
 *
 * NOT A FULL SHAPING ENGINE. No kerning, no ligatures, no GPOS. For digits and
 * currency punctuation in a font with no kern pairs between them, the sum of
 * advances IS the width; for anything else it is an over-estimate, which is the
 * safe direction to be wrong in.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface FontMetrics {
  unitsPerEm: number;
  /** Codepoint → advance width, in font units. */
  advances: Map<number, number>;
  /** The advance used for a codepoint the font does not map. */
  fallback: number;
}

/** Same spelling as cardFonts.ts — see the long note there on why. */
const fontPath = (name: string) =>
  join(/* turbopackIgnore: true */ process.cwd(), 'src/lib/share/fonts', name);

function parseMetrics(file: string): FontMetrics {
  const b = readFileSync(file);

  const tables = new Map<string, number>();
  const numTables = b.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables.set(b.toString('ascii', o, o + 4), b.readUInt32BE(o + 8));
  }

  const head = tables.get('head')!;
  const hhea = tables.get('hhea')!;
  const hmtx = tables.get('hmtx')!;
  const maxp = tables.get('maxp')!;
  const cmap = tables.get('cmap')!;

  const unitsPerEm = b.readUInt16BE(head + 18);
  const numHMetrics = b.readUInt16BE(hhea + 34);
  const numGlyphs = b.readUInt16BE(maxp + 4);

  /**
   * `hmtx` stores one advance per glyph for the first `numHMetrics` glyphs and
   * then omits them — every glyph past that point reuses the LAST advance in
   * the array. That is the compression trick the table exists for, and reading
   * past the end of it is how a monospaced tail turns into garbage.
   */
  const glyphAdvance = (gid: number): number => {
    const i = Math.min(gid, numHMetrics - 1);
    return b.readUInt16BE(hmtx + i * 4);
  };

  // cmap format 4, the Unicode BMP subtable.
  const advances = new Map<number, number>();
  const numSubtables = b.readUInt16BE(cmap + 2);
  let sub = -1;
  for (let i = 0; i < numSubtables; i++) {
    const o = cmap + 4 + i * 8;
    const platform = b.readUInt16BE(o);
    const encoding = b.readUInt16BE(o + 2);
    if (platform === 3 && (encoding === 1 || encoding === 10)) sub = cmap + b.readUInt32BE(o + 4);
    else if (platform === 0 && sub < 0) sub = cmap + b.readUInt32BE(o + 4);
  }
  if (sub >= 0 && b.readUInt16BE(sub) === 4) {
    const segX2 = b.readUInt16BE(sub + 6);
    const endO = sub + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = b.readUInt16BE(endO + s * 2);
      const start = b.readUInt16BE(startO + s * 2);
      if (start === 0xffff) continue;
      const delta = b.readInt16BE(deltaO + s * 2);
      const range = b.readUInt16BE(rangeO + s * 2);
      for (let cp = start; cp <= end; cp++) {
        let gid: number;
        if (range === 0) gid = (cp + delta) & 0xffff;
        else {
          const gi = rangeO + s * 2 + range + (cp - start) * 2;
          if (gi + 1 >= b.length) continue;
          gid = b.readUInt16BE(gi);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0 && gid < numGlyphs) advances.set(cp, glyphAdvance(gid));
      }
    }
  }

  // An unmapped codepoint falls back to the digit zero's advance: this measures
  // numbers, and a tofu box is roughly a digit wide.
  return { unitsPerEm, advances, fallback: advances.get(0x30) ?? unitsPerEm / 2 };
}

let heroMetrics: FontMetrics | null = null;

/** Nunito ExtraBold — the face the hero P&L and every bold figure is set in. */
function metrics(): FontMetrics {
  if (heroMetrics === null) heroMetrics = parseMetrics(fontPath('Nunito-ExtraBold.ttf'));
  return heroMetrics;
}

/** Width of `text` at font-size 1, i.e. in ems. Multiply by the size to get px. */
export function textWidthEm(text: string): number {
  const { unitsPerEm, advances, fallback } = metrics();
  let units = 0;
  for (const ch of text) units += advances.get(ch.codePointAt(0)!) ?? fallback;
  return units / unitsPerEm;
}

/**
 * The largest size at or below `max` at which `text` fits `maxWidth`.
 *
 * `letterSpacing` is passed as a per-character delta because the hero sets it
 * negative — ignoring it would under-estimate the available room, which only
 * ever makes the number smaller than it needed to be. Passing it keeps the
 * fitted size honest in both directions.
 *
 * Floored, not rounded: rounding up is how a string that "fits" lands one pixel
 * over the edge.
 */
export function fitFontSize(
  text: string,
  maxWidth: number,
  max: number,
  letterSpacing = 0
): number {
  const em = textWidthEm(text);
  if (em <= 0) return max;
  const spacing = letterSpacing * Math.max(0, [...text].length - 1);
  const fitted = Math.floor((maxWidth - spacing) / em);
  return Math.max(1, Math.min(max, fitted));
}
