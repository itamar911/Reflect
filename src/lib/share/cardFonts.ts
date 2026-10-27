/**
 * The bytes satori draws the share card with (REF-125 Stage 3 item 1).
 *
 * SERVER ONLY. Reads two files off disk and hands back ArrayBuffers; nothing
 * here belongs in a browser bundle.
 *
 *
 * WHY THERE ARE TTF FILES IN THIS REPO AT ALL
 * -------------------------------------------
 *
 * Until this change the repo committed ZERO font files — every font came from
 * `next/font/google` (layout.tsx loads Rubik; Logo.tsx loads Poppins and
 * Montserrat). None of that output is reusable here, and REF-125 §5.5 verified
 * both reasons by feeding the real artefacts to satori:
 *
 *   1. `next/font` self-hosts **woff2**, and satori rejects it outright —
 *      "Unsupported OpenType signature wOF2". It takes ttf, otf and woff only.
 *   2. Google's Rubik is a **variable** font, and satori cannot select an
 *      instance off a `wght` axis. A variable file renders one master, so
 *      asking for weight 700 would silently give back weight 400.
 *
 * So a STATIC INSTANCE of each weight has to exist as bytes we own. These two
 * came from the Google Fonts legacy CSS endpoint, which answers
 * `format('truetype')` rather than woff2 when asked with an old User-Agent,
 * subsetted to `hebrew,latin`. Both were verified before being committed:
 * sfnt magic `0x00010000`, cmap format 4, 299 mapped codepoints, 47 of them in
 * the Hebrew block, **no `fvar` table** (i.e. genuinely static), and every
 * character this card can render present in both — Hebrew letters, digits,
 * `REFLECT`, the provenance words, and `$ + - . , / : · —`.
 *
 * Rubik rather than Heebo or Noto Sans Hebrew because it is the family the
 * product already uses everywhere else; a share card in a different typeface
 * would be the only Reflect surface that is not Rubik.
 *
 * SIL Open Font License 1.1 — ./fonts/OFL.txt, copied in with the files. The
 * licence requires the notice to travel with the bytes, so it is committed
 * beside them rather than referenced.
 *
 *
 * NEVER FETCHED AT RUNTIME, AND THAT IS THE POINT
 * -----------------------------------------------
 *
 * REF-125 §5.3 found that an `ImageResponse` given NO `fonts` option still
 * rendered Hebrew — which it can only have done by reaching
 * `fonts.googleapis.com` mid-render, because the one font @vercel/og bundles
 * (Geist-Regular.ttf) has ZERO Hebrew coverage. That silent fallback is a
 * third-party dependency on the hot path of a public page, a latency cost on
 * every unfurl, and a blank card in any restricted environment.
 *
 * `shareCardFonts()` therefore always returns both faces, and every
 * `ImageResponse` in this feature passes the result. There is no code path
 * that renders without them.
 */

import { readFileSync } from 'node:fs';

import type { TradingDay } from '@/lib/tradingDay';

/** Satori's font descriptor, restated so this module needs no satori import. */
interface CardFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: 'normal';
}

/**
 * `new URL(…, import.meta.url)` AND NOT `path.join(process.cwd(), …)`.
 *
 * The bundler understands the first form: it treats the file as an asset,
 * emits it into the server output, and rewrites the URL to point at the copy.
 * A `process.cwd()` path is an opaque string it cannot follow, so the font
 * would be missing from the deployment bundle and the route would throw ENOENT
 * in production while working perfectly in `next dev` — the worst available
 * failure mode for a change whose whole purpose is a file on disk.
 */
const FACES = [
  { file: new URL('./fonts/Rubik-Regular.ttf', import.meta.url), weight: 400 as const },
  { file: new URL('./fonts/Rubik-Bold.ttf', import.meta.url), weight: 700 as const },
];

/**
 * Read once per process, not once per request.
 *
 * ~120 KB across the two files. The route is public and a social unfurl can
 * arrive in bursts, so re-reading on every render would be a syscall pair per
 * request for bytes that cannot change between deploys.
 */
let cached: CardFont[] | null = null;

export function shareCardFonts(): CardFont[] {
  if (cached === null) {
    cached = FACES.map(({ file, weight }) => ({
      name: 'Rubik',
      // `readFileSync` takes a file: URL directly. The Buffer is copied into a
      // standalone ArrayBuffer because a Node Buffer is a VIEW onto a shared
      // pool — handing satori `buffer.buffer` would hand it the whole pool,
      // including whatever else happened to be allocated beside it.
      data: toArrayBuffer(readFileSync(file)),
      weight,
      style: 'normal' as const,
    }));
  }
  return cached;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * The day, as the CARD prints it — short, numeric, and pinned to Israel time.
 *
 * NOT `tradingDayLabel()`, which is the product's in-app phrasing. Three
 * reasons this one is separate rather than reused:
 *
 *   1. THE CARD HAS NO BIDI ENGINE. satori resolves no paragraph direction
 *      (REF-125 §5.4), so any label mixing a Hebrew weekday with Latin digits
 *      in one text node lays out unpredictably. This returns digits only, so
 *      it is a pure LTR run that can be placed as its own element.
 *   2. A card is read at a glance and at a distance. "27.10.2026" is the whole
 *      of what a date needs to say on it.
 *   3. `toLocaleDateString` on the server formats in Vercel's UTC, which is
 *      the SSR timezone trap REF-125 §6.5 names. The day is already a
 *      `YYYY-MM-DD` string decided by the Stage 1 trading-day definition, so
 *      this reformats the STRING and never constructs a Date at all — there is
 *      no timezone for it to be wrong about.
 */
export function cardDateLabel(day: TradingDay): string {
  const [year, month, date] = day.split('-');
  if (!year || !month || !date) return day;
  return `${date}.${month}.${year}`;
}
