/**
 * The card's QR code (REF-125 Stage 3).
 *
 * SERVER ONLY, and satori-only. The output is an SVG data URI that
 * `cardImage.tsx` hands to an `<img>` inside the satori tree — the same shape
 * as the dot grid, and for the same reason: one `<img>` that resvg rasterises
 * beats ~1,400 sibling divs on a route a social platform can hit in bursts.
 *
 *
 * WHY A DEPENDENCY RATHER THAN A HAND-ROLLED ENCODER
 * --------------------------------------------------
 *
 * `qrcode-generator` is MIT, has ZERO runtime dependencies, and ships its own
 * types. A QR encoder is Reed-Solomon over GF(256), eight mask patterns scored
 * against four penalty rules, and a version/block table — about 600 lines whose
 * failure mode is the worst kind there is: the code LOOKS perfect and scans to
 * the wrong thing, or to nothing. This is the one element on the card a reader
 * ACTS on, so it gets the implementation that has been pointed at by millions
 * of cameras rather than one written this afternoon.
 *
 * `scripts/share-card-check.ts` still decodes the matrix back out independently
 * — the dependency is trusted to encode, not trusted to have been wired up
 * correctly here.
 *
 *
 * ERROR CORRECTION LEVEL M, AND NOTHING COVERING IT
 * -------------------------------------------------
 *
 * 'M' recovers ~15%, which is the usual default. 'L' would drop a share URL
 * from a version 5 symbol to a version 4 — fewer, larger modules, and easier to
 * scan from a phone screen — but the margin is thin: a 43-character token
 * already fills 78 of version 4's 80 data codewords at that level, so one extra
 * path segment would silently push it back up a version anyway. M is taken for
 * the headroom rather than for damage resistance; nothing is overlaid on this
 * symbol, so there is no logo punch-out to pay for.
 */

import qrcode from 'qrcode-generator';

/**
 * The modules, row-major, `true` where dark.
 *
 * Type number 0 asks the encoder for the SMALLEST version the payload fits,
 * which is what keeps the modules as large as they can be for a given URL.
 * Byte mode is named explicitly rather than left to mode detection: a share URL
 * is mixed-case and would never qualify for alphanumeric mode, and pinning it
 * means the decoder in the check script has one header shape to read.
 */
export function cardQrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col))
  );
}

/**
 * The symbol as an SVG data URI, sized in module units.
 *
 * ONE `<path>` FOR THE WHOLE SYMBOL, not one `<rect>` per module. A version 5
 * symbol is 37×37, so roughly 700 of its 1,369 modules are dark; as separate
 * elements that is a 40 KB data URI on every render, against about 9 KB for a
 * single path. resvg fills it in one pass either way.
 *
 * NO QUIET ZONE IN THE SVG. The four-module light border a scanner needs is
 * padding on the white tile `cardImage.tsx` wraps this in — expressed there, in
 * layout, rather than baked into the image, so the tile's own rounding and the
 * quiet zone cannot disagree about where the symbol ends.
 *
 * `shape-rendering="crispEdges"` because module edges land on fractional pixels
 * once the symbol is scaled to fit the card's slot, and anti-aliased module
 * boundaries are exactly what makes a small QR fail to resolve.
 */
export function qrSvgDataUri(text: string, moduleColor: string): string {
  const matrix = cardQrMatrix(text);
  const count = matrix.length;

  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      // `h1 v1 h-1 z` rather than `h1 v1 h-1 v-1 z`: the close already returns
      // to the start point, so the fourth side is a wasted pair of bytes on
      // every dark module.
      if (matrix[row]![col]) d += `M${col} ${row}h1v1h-1z`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count} ${count}" ` +
    `shape-rendering="crispEdges"><path d="${d}" fill="${moduleColor}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * The URL a card's QR points at.
 *
 * The canonical origin is hard-coded here for the same reason `layout.tsx`
 * states it as `metadataBase`: an origin assembled from a request header is
 * forgeable and gets the scheme wrong behind the proxy — and unlike a meta tag,
 * a wrong origin baked into a QR is published as pixels into somebody's feed
 * and cannot be corrected after the fact.
 */
export const SHARE_ORIGIN = 'https://reflecttrading.app';

export function shareUrlForToken(token: string): string {
  return `${SHARE_ORIGIN}/share/${token}`;
}
