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
 * The same two checks were run on the two NUNITO instances added when the card
 * was redesigned: static magic, no `fvar`, cmap format 4, 545 mapped
 * codepoints, and every character the card prints present in both weights —
 * letters, digits, `$ + - . , / % ' ·`. ZERO of those codepoints are in the
 * Hebrew block, which is deliberate and is why Rubik stays (see FACES).
 *
 * SIL Open Font License 1.1 — ./fonts/OFL.txt, copied in with the files. It
 * covers both families: Rubik and Nunito ship under the same licence, and the
 * one copy carries both copyright lines. The licence requires the notice to
 * travel with the bytes, so it is committed beside them rather than referenced.
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
import { join } from 'node:path';

import type { TradingDay } from '@/lib/tradingDay';

/** Satori's font descriptor, restated so this module needs no satori import. */
interface CardFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600 | 700 | 800;
  style: 'normal';
}

/**
 * WHERE THE BYTES ARE, AND WHY IT IS SPELLED LIKE THIS.
 *
 * The obvious form — `readFileSync(new URL('./fonts/x.ttf', import.meta.url))`
 * — builds and runs, but Turbopack cannot follow it. It emits:
 *
 *   "Encountered unexpected file in NFT list. A file was traced that indicates
 *    that the whole project was traced unintentionally."
 *
 * i.e. having failed to resolve the reference statically, it gives up and
 * traces EVERYTHING into the serverless bundle for this route. That is a real
 * cost on a public route, and it makes the fonts' presence in the deployment
 * an accident of over-tracing rather than something declared — which would
 * stop being true the moment the trace got tighter.
 *
 * So this does BOTH halves of what that warning asks for:
 *
 *   - `/* turbopackIgnore: true *\/` tells the bundler to stop trying to
 *     resolve the path, which is what stops the over-trace. It is the escape
 *     hatch the warning itself names.
 *   - `outputFileTracingIncludes` in next.config.ts then names these two files
 *     for this route explicitly, so they are in the bundle BECAUSE A CONFIG
 *     SAYS SO rather than because the tracer gave up and took everything.
 *
 * Only doing the first half would be the real bug: the warning would go away
 * and the fonts would go with it. The two edits belong together, and the
 * config carries the same note.
 *
 * Kept in `src/` next to the module that reads them rather than in `public/`:
 * these are not public assets. Serving the raw TTFs at a URL would invite a
 * hotlink and says nothing to a browser that the app does not already get from
 * next/font.
 */
const FONT_DIR = 'src/lib/share/fonts';

const fontPath = (name: string) =>
  join(/* turbopackIgnore: true */ process.cwd(), FONT_DIR, name);

/**
 * TWO FAMILIES, AND THEY HAVE DIFFERENT JOBS.
 *
 * NUNITO is the card's typeface and the card's alone — a rounded grotesque that
 * reads as a product rather than as a spreadsheet, which is the whole of why
 * the first cut was rejected. The app keeps Rubik; nothing outside
 * `cardImage.tsx` may reference Nunito, because adding it to a page would mean
 * a second webfont on the critical path for a face used by one PNG.
 *
 * RUBIK IS CARRIED ONLY AS A HEBREW FALLBACK. The card is ENGLISH ONLY by
 * decision — every label, the provenance line and the domain — so the single
 * string on it that can hold a Hebrew glyph is the trader's chosen nickname.
 * Nunito is latin-only (verified: 545 mapped codepoints, ZERO in the Hebrew
 * block), so without Rubik in this list a Hebrew handle rasterises as a row of
 * tofu. satori picks the fallback per glyph when the first family cannot supply
 * one; `cardImage.tsx` additionally names Rubik outright on that one span so
 * the choice is not left to a fallback chain.
 *
 * Weights are the real static instances, not synthesised: ExtraBold is 800 and
 * SemiBold is 600, and asking for a weight no file supplies gets the nearest
 * one rather than a faux-bolded outline.
 */
const FACES = [
  { file: fontPath('Nunito-SemiBold.ttf'), family: 'Nunito', weight: 600 as const },
  { file: fontPath('Nunito-ExtraBold.ttf'), family: 'Nunito', weight: 800 as const },
  { file: fontPath('Rubik-Regular.ttf'), family: 'Rubik', weight: 400 as const },
  { file: fontPath('Rubik-Bold.ttf'), family: 'Rubik', weight: 700 as const },
];

/**
 * Read once per process, not once per request.
 *
 * ~255 KB across the four files. The route is public and a social unfurl can
 * arrive in bursts, so re-reading on every render would be four syscall pairs
 * per request for bytes that cannot change between deploys.
 */
let cached: CardFont[] | null = null;

export function shareCardFonts(): CardFont[] {
  if (cached === null) {
    cached = FACES.map(({ file, family, weight }) => ({
      name: family,
      // The Buffer is copied into a standalone ArrayBuffer because a Node
      // Buffer is a VIEW onto a shared pool — handing satori `buffer.buffer`
      // would hand it the whole pool, including whatever else happened to be
      // allocated beside it.
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
