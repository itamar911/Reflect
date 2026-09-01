// Regenerates public/auth/phone-demo.png — the phone mockup on the auth pages —
// from /demo/phone-showcase.
//
// Usage:
//   npm run build && npm run start        (in one shell)
//   node scripts/capture-phone-demo.mjs   (in another)
//
// Why /demo/phone-showcase and not /phone-showcase: the bare route is behind the
// auth gate like every app route, so an unauthenticated capture would shoot the
// login page. The /demo prefix is rewritten by proxy.ts to the same page with the
// fixture header set, which is exactly the composition we want.
//
// This existed only as an ad-hoc command before, which is how the previous
// capture ended up published without anyone re-checking what was in it. It is a
// script now so the next re-capture is one command and the geometry below cannot
// drift by accident.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const URL    = process.env.CAPTURE_URL ?? 'http://localhost:3000/demo/phone-showcase';
const OUT    = 'public/auth/phone-demo.png';

// 390x844 is the iPhone logical viewport the page composes against; DSF 2 gives
// the 780x1688 intrinsic size AuthShowcase declares for the <Image>.
const WIDTH  = 390;
const HEIGHT = 844;
const SCALE  = 2;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    colorScheme: 'dark',
  });

  const response = await page.goto(URL, { waitUntil: 'networkidle' });
  if (!response || !response.ok()) {
    throw new Error(`${URL} returned ${response ? response.status() : 'no response'} — is the prod server running?`);
  }

  // The composition is static, but fonts settle a beat after networkidle and a
  // half-loaded webfont bakes the fallback metrics into the PNG.
  await page.evaluate(() => document.fonts.ready);

  // Page furniture that belongs on the route but not inside the phone.
  //
  //   - The floating widgets come from the root layout and sit on top of the
  //     composition — the accessibility button lands in the bottom-left corner,
  //     over the last trade row. (The first capture after the recompose shipped
  //     with it baked in; this is why.)
  //   - The disclosure footer is required on the route, which is publicly
  //     reachable at /demo/phone-showcase, but it is not part of the mockup.
  //     Hidden here, never removed from the page.
  //
  // Hidden for the shot only. If a future change means one of these *should*
  // appear in the image, take it out of this list rather than off the page.
  await page.addStyleTag({
    content: `
      [aria-label="הגדרות נגישות"],
      [aria-label="שיחה בוואטסאפ"],
      footer,
      .skip-link { display: none !important; }
    `,
  });

  // Fail loudly rather than silently re-publishing a prohibited figure: a win
  // rate is on the guidelines' explicit prohibition list, and money P&L reads as
  // hypothetical performance. See the header comment in the page itself.
  const text = await page.evaluate(() => document.body.innerText);
  const banned = [
    [/אחוז(?:י)? הצלחה/, 'a win-rate label'],
    [/₪\s*[\d,]+/, 'a shekel P&L figure'],
    [/מאזן\s*P&L/, 'a P&L balance panel'],
  ];
  const found = banned.filter(([re]) => re.test(text)).map(([, what]) => what);
  if (found.length) {
    throw new Error(
      `Refusing to capture: the page shows ${found.join(' and ')}.\n` +
      `This image is published on every auth screen, so it must not carry performance figures.`
    );
  }

  await mkdir(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, fullPage: false });
  console.log(`Captured ${OUT} at ${WIDTH * SCALE}x${HEIGHT * SCALE}`);
} finally {
  await browser.close();
}
