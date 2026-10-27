/**
 * Render the share card to PNGs from fixture snapshots, for visual review.
 *
 *   npx tsx scripts/share-card-render.ts [outDir]
 *
 * NOT A TEST and not wired into `npm test:*`. Every other script in this
 * directory asserts something and exits non-zero; this one produces images a
 * human looks at, because the thing it checks — "does this card look like a
 * product we would want somebody to paste into a group chat" — has no
 * assertion. It exists so that review happens against REAL RENDERS at the real
 * sizes rather than against a description of them, and so that re-rendering
 * after a design change is one command rather than a rebuilt server.
 *
 * It imports the SAME component the route does (`ShareCardImage`), so an image
 * approved here is the image the route serves. It does not import the route
 * itself: `next/og` resolves as a bare specifier only under Next's bundler, so
 * a standalone script has to name the file (`next/og.js`).
 *
 * THE FIXTURES CARRY NO REAL DATA. Invented days, invented amounts, and the
 * nickname is a generic Hebrew noun phrase. Nothing here reads the database —
 * the card is built from a snapshot literal, which is exactly what the stored
 * `snapshot` column holds, so this exercises the real rendering path.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ImageResponse } from 'next/og.js';

import { shareCardFonts } from '../src/lib/share/cardFonts';
import { CARD_SIZES, ShareCardImage, type ShareCardSize } from '../src/lib/share/cardImage';
import { SHARE_SNAPSHOT_VERSION, type DailyShareSnapshot } from '../src/lib/share/snapshot';

/** A green day, broker-synced, with a handle shown and both fractions answered. */
const WIN_DAY: DailyShareSnapshot = {
  v: SHARE_SNAPSHOT_VERSION,
  day: '2026-10-27',
  pnl: 1240.5,
  trades: 5,
  wins: 3,
  losses: 2,
  followedPlan: { met: 4, answered: 5 },
  stopHeld: { met: 5, answered: 5 },
  best: 820.25,
  worst: -210,
  provenance: 'broker',
  nickname: 'סוחר מדד',
  // Three accounts, mixed signs — the common broker-synced shape, and the one
  // that shows the panel doing its job: the hero is the SUM, and the rows say
  // where it came from.
  accounts: [
    { name: 'Main Futures', pnl: 1480.5, broker: true },
    { name: 'Topstep Combine', pnl: 95, broker: true },
    { name: 'Eval 50K', pnl: -335, broker: true },
  ],
};

/** A red day, mixed provenance, anonymous, one fraction unanswered. */
const LOSS_DAY: DailyShareSnapshot = {
  v: SHARE_SNAPSHOT_VERSION,
  day: '2026-10-26',
  pnl: -1875.25,
  trades: 7,
  wins: 2,
  losses: 5,
  followedPlan: { met: 2, answered: 6 },
  stopHeld: null,
  best: 140,
  worst: -960.75,
  provenance: 'mixed',
  nickname: null,
  // Two accounts, both red, one of them manual — so the row mark is not
  // uniform and the panel has to survive that.
  accounts: [
    { name: 'Main Futures', pnl: -640.25, broker: true },
    { name: 'Swing Account', pnl: -1235, broker: false },
  ],
};

/**
 * The shapes that are easy to forget: nothing happened, and nothing was
 * recorded. Rendered because every withheld field on this card is a branch,
 * and a branch nobody has looked at is where "—" becomes "$0.00".
 */
const QUIET_DAY: DailyShareSnapshot = {
  v: SHARE_SNAPSHOT_VERSION,
  day: '2026-10-25',
  pnl: null,
  trades: 0,
  wins: 0,
  losses: 0,
  followedPlan: null,
  stopHeld: null,
  best: null,
  worst: null,
  provenance: 'manual',
  nickname: null,
  // Nothing happened, so there is nothing to attribute. The panel is withheld
  // whole rather than rendered empty.
  accounts: [],
};

/** A six-figure loss — the longest string the money slot ever holds. */
const BIG_LOSS_DAY: DailyShareSnapshot = {
  ...LOSS_DAY,
  day: '2026-10-23',
  pnl: -124875.5,
  nickname: 'חשבון הדגמה',
  /**
   * SEVEN accounts, so the card has to cut the list and say "+2 more" — and a
   * Hebrew account name, because `display_name` is free text the trader chose
   * and the card is English. It is the one string on the panel that can hold a
   * Hebrew glyph, so it goes through the same reordering the nickname does.
   * The longest money string sits beside the longest list on purpose.
   */
  accounts: [
    { name: 'Main Futures', pnl: 14200, broker: true },
    { name: 'Topstep Combine', pnl: 2180.25, broker: true },
    { name: 'החשבון הראשי שלי', pnl: -1120, broker: true },
    { name: 'Eval 50K', pnl: -8400, broker: true },
    { name: 'Apex 100K', pnl: -22650.75, broker: true },
    { name: 'Swing Account', pnl: -44320, broker: false },
    { name: 'Unassigned', pnl: -64765, broker: false },
  ],
};

const CASES: ReadonlyArray<{ name: string; snapshot: DailyShareSnapshot }> = [
  { name: 'win-day', snapshot: WIN_DAY },
  { name: 'loss-day', snapshot: LOSS_DAY },
  { name: 'quiet-day', snapshot: QUIET_DAY },
  { name: 'big-loss', snapshot: BIG_LOSS_DAY },
];

const SIZES: readonly ShareCardSize[] = ['og', 'square'];

/**
 * An INVENTED token, at the real length.
 *
 * 32 random bytes as base64url is 43 characters, and the QR encodes the whole
 * share URL — so a short placeholder here would render a smaller symbol than
 * production ever produces and the renders would under-report how dense the QR
 * actually is. This string is not a token that exists; nothing looks it up.
 */
const FIXTURE_TOKEN = 'JvZ3k1Qx7LpR2mN8tYw0aBcDeFgHiJkLmNoPqRsTuVw';

async function main() {
  const outDir = process.argv[2] ?? join(process.cwd(), 'tmp', 'share-cards');
  mkdirSync(outDir, { recursive: true });

  const fonts = shareCardFonts();

  for (const { name, snapshot } of CASES) {
    for (const size of SIZES) {
      const response = new ImageResponse(
        <ShareCardImage snapshot={snapshot} tradingDay={snapshot.day} size={size} token={FIXTURE_TOKEN} />,
        { ...CARD_SIZES[size], fonts }
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      const file = join(outDir, `${name}-${size}.png`);
      writeFileSync(file, bytes);
      const { width, height } = CARD_SIZES[size];
      console.log(`${file}  ${width}×${height}  ${Math.round(bytes.length / 1024)} KB`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
