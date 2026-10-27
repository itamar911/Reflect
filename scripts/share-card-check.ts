/**
 * The share card's two untestable-looking things, pinned down (REF-125 Stage 3).
 *
 * This suite exists because of a specific failure. The first batch of approval
 * renders went out with EVERY HEBREW STRING ON THE CARD LETTER-REVERSED —
 * `תוצאת היום` rasterised as `םויה תאצות` — and the reason it got that far is
 * that the claim "satori reverses within a run" lived in a docblock, where
 * nothing could contradict it. A comment cannot fail. These assertions can.
 *
 * Two groups:
 *
 *   1. `toVisualOrder` (src/lib/share/cardBidi.ts) — the reordering the card
 *      applies to a trader's nickname, which after the English-only redesign is
 *      the ONLY string on the image that can hold a Hebrew glyph.
 *   2. `cardQrMatrix` (src/lib/share/cardQr.ts) — the QR encoder, checked
 *      against the fixed patterns the spec mandates and, more usefully, decoded
 *      back out of its own matrix.
 *
 * Usage: npm run test:share-card
 * Exits non-zero on the first failing group's summary.
 */
import { hasRtl, toVisualOrder } from '../src/lib/share/cardBidi';
import { cardQrMatrix, shareUrlForToken } from '../src/lib/share/cardQr';

interface Case {
  label: string;
  got: string;
  want: string;
}

const failures: string[] = [];

function group(name: string, cases: Case[]) {
  const bad = cases.filter((c) => c.got !== c.want);
  console.log(`${bad.length ? 'FAIL  ' : 'ok    '}${name}  (${cases.length - bad.length}/${cases.length})`);
  for (const c of bad) {
    console.log(`         ${c.label}: got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`);
    failures.push(`${name} / ${c.label}`);
  }
}

const c = (label: string, got: string, want: string): Case => ({ label, got, want });

// ── English is untouched ─────────────────────────────────────────────────────
//
// The card is English only, so the overwhelmingly common path through this
// function is "give it back exactly". A regression here would scramble every
// label on the image, which is a far bigger blast radius than the Hebrew case
// it exists for.

group('latin passes through unchanged', [
  c('a label', toVisualOrder("TODAY'S P&L"), "TODAY'S P&L"),
  c('the provenance line', toVisualOrder('Broker-synced · before fees'), 'Broker-synced · before fees'),
  c('the domain', toVisualOrder('reflecttrading.app'), 'reflecttrading.app'),
  c('a latin nickname', toVisualOrder('Index Trader'), 'Index Trader'),
  c('the fallback name', toVisualOrder('Reflect trader'), 'Reflect trader'),
  c('digits', toVisualOrder('27/10/2026'), '27/10/2026'),
  c('a money string', toVisualOrder('-$124,875.50'), '-$124,875.50'),
  c('empty', toVisualOrder(''), ''),
]);

// ── Hebrew reverses, per word AND per phrase ────────────────────────────────
//
// Both halves matter and they are different bugs. Reversing the letters but not
// the word order gives a name whose words read backwards; reversing the words
// but not the letters gives gibberish. The fixture nickname `סוחר מדד` is the
// one in the render script, so a failure here is visible in the approval PNGs.

const SOCHER = 'סוחר';
const MADAD = 'מדד';

group('hebrew is reordered for a bidi-less renderer', [
  c('one word', toVisualOrder(SOCHER), [...SOCHER].reverse().join('')),
  c(
    'two words: letters AND word order reverse',
    toVisualOrder(`${SOCHER} ${MADAD}`),
    `${[...MADAD].reverse().join('')} ${[...SOCHER].reverse().join('')}`
  ),
  // The property that actually defines correctness for a pure-RTL string:
  // visual order left-to-right is the logical sequence reversed, whole.
  c(
    'pure RTL equals a whole-string reverse',
    toVisualOrder(`${SOCHER} ${MADAD}`),
    [...`${SOCHER} ${MADAD}`].reverse().join('')
  ),
  c('applying it twice is the identity', toVisualOrder(toVisualOrder(`${SOCHER} ${MADAD}`)), `${SOCHER} ${MADAD}`),
  c('length is preserved', String(toVisualOrder(`${SOCHER} ${MADAD}`).length), String(`${SOCHER} ${MADAD}`.length)),
]);

// ── Digits and Latin inside a Hebrew name keep their own order ──────────────
//
// This is the case a naive whole-string `.reverse()` gets wrong, and it is not
// hypothetical: `MAX_PUBLIC_NICKNAME` is 24 characters of free text and traders
// put instrument names and years in them. `2026` must not become `6202`.

group('embedded LTR runs survive', [
  c(
    'a year inside a hebrew phrase',
    toVisualOrder(`${SOCHER} 2026`),
    `2026 ${[...SOCHER].reverse().join('')}`
  ),
  c(
    'a latin word inside a hebrew phrase',
    toVisualOrder(`${SOCHER} Nasdaq`),
    `Nasdaq ${[...SOCHER].reverse().join('')}`
  ),
  c('the digits are not reversed', toVisualOrder(`${SOCHER} 2026`).includes('2026') ? 'intact' : 'scrambled', 'intact'),
  c('the latin is not reversed', toVisualOrder(`${SOCHER} Nasdaq`).includes('Nasdaq') ? 'intact' : 'scrambled', 'intact'),
  // Base direction is first-strong: a name that OPENS in Latin stays an LTR
  // phrase, so the words keep their order and only the Hebrew run flips.
  c(
    'latin-first keeps LTR base',
    toVisualOrder(`Nasdaq ${SOCHER}`),
    `Nasdaq ${[...SOCHER].reverse().join('')}`
  ),
]);

// ── Grapheme safety ─────────────────────────────────────────────────────────
//
// Reversing by code unit splits surrogate pairs into lone halves and drags
// combining marks off the letters they belong to. A nickname is free text, so
// both can arrive.

const NIQQUD = 'שָׁלוֹם'; // Hebrew with vowel points: combining marks on bases.

group('grapheme clusters stay whole', [
  c(
    'niqqud stays attached to its base',
    // Every combining mark must still follow a base letter, i.e. the string
    // must never START with one after reordering.
    /^[֑-ׇ]/.test(toVisualOrder(NIQQUD)) ? 'orphaned mark' : 'attached',
    'attached'
  ),
  c('niqqud round-trips', toVisualOrder(toVisualOrder(NIQQUD)), NIQQUD),
  c(
    'no lone surrogates',
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(toVisualOrder(`${SOCHER} \u{1F4C8}`))
      ? 'split pair'
      : 'intact',
    'intact'
  ),
]);

group('hasRtl', [
  c('latin', String(hasRtl('Reflect trader')), 'false'),
  c('digits', String(hasRtl('2026')), 'false'),
  c('hebrew', String(hasRtl(SOCHER)), 'true'),
  c('mixed', String(hasRtl(`Nasdaq ${SOCHER}`)), 'true'),
]);

// ── The QR code ─────────────────────────────────────────────────────────────
//
// The card's QR is the only element on it a reader ACTS on, and a QR that
// scans to the wrong thing looks perfect. So this decodes the matrix back
// rather than checking that it is merely square and plausible.

/**
 * Level-M block structure, versions 1-10:
 * `[ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]`.
 *
 * Only the data counts are used — the EC codewords are not checked, because
 * this decoder reads a symbol it has just been handed rather than one recovered
 * from a damaged photograph. Table from ISO/IEC 18004 §7.5.
 */
const LEVEL_M_BLOCKS: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const QR_URL = 'https://reflecttrading.app/share/abc123def456';
const qr = cardQrMatrix(QR_URL);

/** The three 7×7 finder patterns, which a scanner locates before anything else. */
function finderOk(m: boolean[][], row: number, col: number): boolean {
  const want = [
    '1111111',
    '1000001',
    '1011101',
    '1011101',
    '1011101',
    '1000001',
    '1111111',
  ];
  for (let r = 0; r < 7; r++) {
    for (let cl = 0; cl < 7; cl++) {
      if (m[row + r]![col + cl]! !== (want[r]![cl] === '1')) return false;
    }
  }
  return true;
}

group('qr structure', [
  c('square', String(qr.length === qr[0]!.length), 'true'),
  c('version 1-10 size', String(qr.length >= 21 && qr.length <= 57 && (qr.length - 21) % 4 === 0), 'true'),
  c('top-left finder', String(finderOk(qr, 0, 0)), 'true'),
  c('top-right finder', String(finderOk(qr, 0, qr.length - 7)), 'true'),
  c('bottom-left finder', String(finderOk(qr, qr.length - 7, 0)), 'true'),
  // The timing patterns alternate; a scanner uses them to size the module grid.
  c(
    'horizontal timing alternates',
    String(Array.from({ length: qr.length - 16 }, (_, i) => qr[6]![8 + i]! === (i % 2 === 0)).every(Boolean)),
    'true'
  ),
  c(
    'vertical timing alternates',
    String(Array.from({ length: qr.length - 16 }, (_, i) => qr[8 + i]![6]! === (i % 2 === 0)).every(Boolean)),
    'true'
  ),
  c('dark module', String(qr[qr.length - 8]![8]!), 'true'),
]);

/**
 * A REAL share URL, at the real length — 32 random bytes as base64url is 43
 * characters, so the whole URL is 76. This is the case production actually
 * encodes, and it is the one that proves the decoder above is doing something:
 * 76 bytes lands on a VERSION 5 symbol, which at level M is split across TWO
 * Reed-Solomon blocks. A decoder that ignored interleaving passes every shorter
 * fixture here and fails this one.
 */
const REAL_TOKEN = 'JvZ3k1Qx7LpR2mN8tYw0aBcDeFgHiJkLmNoPqRsTuVw';
const REAL_URL = shareUrlForToken(REAL_TOKEN);

group('qr payload', [
  c('decodes back to the url it was given', decodeQr(qr), QR_URL),
  c('a short url also round-trips', decodeQr(cardQrMatrix('https://reflecttrading.app')), 'https://reflecttrading.app'),
  c('the real token length round-trips', decodeQr(cardQrMatrix(REAL_URL)), REAL_URL),
  c('the real token length is 43 chars', String(REAL_TOKEN.length), '43'),
  c('shareUrlForToken builds the canonical origin', REAL_URL, `https://reflecttrading.app/share/${REAL_TOKEN}`),
  // Named so the next person knows which symbol size the design was spaced for.
  c('the real url is a version 5 symbol', String((cardQrMatrix(REAL_URL).length - 17) / 4), '5'),
]);

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('share card: all groups passed');

/**
 * Read a byte-mode QR matrix back out, independently of the encoder.
 *
 * DELIBERATELY NOT SHARING CODE WITH THE ENCODER beyond the format constants:
 * a decoder built from the encoder's own helpers would agree with it about any
 * mistake they had in common. This walks the zig-zag placement in reverse,
 * un-masks with the mask the format bits declare, and reads the byte-mode
 * segment header — which is the same thing a phone camera does.
 */
function decodeQr(m: boolean[][]): string {
  const size = m.length;

  // Format information, top-left copy: 15 bits, XORed with the format mask.
  const fmtBits: boolean[] = [];
  for (let i = 0; i <= 5; i++) fmtBits.push(m[8]![i]!);
  fmtBits.push(m[8]![7]!, m[8]![8]!, m[7]![8]!);
  for (let i = 5; i >= 0; i--) fmtBits.push(m[i]![8]!);
  const fmt = fmtBits.reduce((acc, b) => (acc << 1) | (b ? 1 : 0), 0) ^ 0b101010000010010;
  const mask = (fmt >> 10) & 0b111;

  const maskFn = (r: number, cl: number): boolean => {
    switch (mask) {
      case 0: return (r + cl) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return cl % 3 === 0;
      case 3: return (r + cl) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(cl / 3)) % 2 === 0;
      case 5: return ((r * cl) % 2) + ((r * cl) % 3) === 0;
      case 6: return (((r * cl) % 2) + ((r * cl) % 3)) % 2 === 0;
      default: return (((r + cl) % 2) + ((r * cl) % 3)) % 2 === 0;
    }
  };

  // Which cells carry data: everything that is not a function pattern.
  const version = (size - 17) / 4;
  const reserved = functionMap(size, version);

  // The zig-zag walk: two-module-wide columns from the right, alternating up
  // and down, skipping the vertical timing line at column 6.
  const bits: number[] = [];
  let upward = true;
  let col = size - 1;
  while (col > 0) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const cl of [col, col - 1]) {
        if (cl < 0 || reserved[row]![cl]) continue;
        bits.push(m[row]![cl]! !== maskFn(row, cl) ? 1 : 0);
      }
    }
    upward = !upward;
    col -= 2;
  }

  // Codewords, still interleaved across the Reed-Solomon blocks.
  const stream: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    stream.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }

  /**
   * DE-INTERLEAVING IS NOT OPTIONAL, and skipping it is the mistake that makes
   * a decoder "work" right up until the payload crosses a version boundary.
   * From version 4 at level M the data is split across two or more RS blocks
   * and written round-robin — codeword 0 of block 0, codeword 0 of block 1,
   * codeword 1 of block 0, and so on — so reading the stream straight off the
   * matrix gives bytes in the wrong order for every multi-block version. A
   * 43-character share token lands on version 5, which has two blocks.
   */
  const layout = LEVEL_M_BLOCKS[version];
  if (!layout) return `<no block layout for version ${version}>`;
  const [, g1Count, g1Data, g2Count, g2Data] = layout;
  const blocks: number[][] = [
    ...Array.from({ length: g1Count }, () => [] as number[]),
    ...Array.from({ length: g2Count }, () => [] as number[]),
  ];
  const blockLen = (i: number) => (i < g1Count ? g1Data : g2Data);
  const totalData = g1Count * g1Data + g2Count * g2Data;

  let read = 0;
  for (let i = 0; read < totalData; i++) {
    for (let b = 0; b < blocks.length && read < totalData; b++) {
      if (i < blockLen(b)) blocks[b]!.push(stream[read++]!);
    }
  }
  const data = blocks.flat();

  // The byte-mode segment, read out of the de-interleaved codewords.
  const dataBits = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (byte >> s) & 1));
  const take = (n: number, at: number) => dataBits.slice(at, at + n).reduce((a, b) => (a << 1) | b, 0);
  const mode = take(4, 0);
  if (mode !== 0b0100) return `<not byte mode: ${mode}>`;
  const lenBits = version <= 9 ? 8 : 16;
  const len = take(lenBits, 4);
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(take(8, 4 + lenBits + i * 8));
  return Buffer.from(bytes).toString('utf8');
}


/** True where a module belongs to a function pattern and carries no data. */
function functionMap(size: number, version: number): boolean[][] {
  const map = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const fill = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++)
      for (let cl = c0; cl < c0 + w; cl++)
        if (r >= 0 && r < size && cl >= 0 && cl < size) map[r]![cl] = true;
  };
  // Finders plus their separators, and the format-information strips.
  fill(0, 0, 9, 9);
  fill(0, size - 8, 9, 8);
  fill(size - 8, 0, 8, 9);
  // Timing.
  fill(6, 0, 1, size);
  fill(0, 6, size, 1);
  // Alignment patterns, for versions 2 and up.
  if (version >= 2) {
    const coords = alignmentCoords(version);
    for (const r of coords)
      for (const cl of coords) {
        const nearFinder =
          (r <= 8 && cl <= 8) || (r <= 8 && cl >= size - 9) || (r >= size - 9 && cl <= 8);
        if (!nearFinder) fill(r - 2, cl - 2, 5, 5);
      }
  }
  return map;
}

function alignmentCoords(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const last = version * 4 + 10;
  const step = version === 32 ? 26 : Math.ceil((last - 6) / (count - 1) / 2) * 2;
  const coords = [6];
  for (let i = count - 1; i > 0; i--) coords.push(last - (count - 1 - i) * step);
  return coords.sort((a, b) => a - b);
}
