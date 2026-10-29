/**
 * The share card cannot publish what it must not publish (REF-125 Stage 2
 * item 7).
 *
 * Run: npm run test:share
 *
 * No network, no Supabase, no credential, no .env — the snapshot builder is
 * pure by construction and that is most of why it is (see
 * src/lib/share/snapshot.ts' header). Everything here is built from fixture
 * rows and asserted against the SERIALISED JSON, which is the form the
 * database stores and the public page reads.
 *
 * Plain assertions and a non-zero exit, like every other suite in this
 * directory. There is no test runner in this repo and adding one for a ticket
 * would be a bigger change than the ticket — scripts/money-format-check.ts and
 * scripts/trading-day-check.ts say the same thing in their own headers.
 *
 *
 * WHY A GREP OVER THE JSON AND NOT A FIELD-BY-FIELD COMPARISON
 * -----------------------------------------------------------
 *
 * Because the failure being guarded against is a field NOBODY LISTED. A
 * property-by-property assertion can only check the fields it names, so it
 * passes unchanged on the day somebody spreads a row into the snapshot — which
 * is the exact mistake `buildDailyShareSnapshot` is written to make
 * impossible, and the exact mistake worth a regression test. Serialising and
 * searching for the fixture's secrets catches any path by which they arrive,
 * including one that does not exist yet.
 *
 * The values searched for are REF-125 §2.5's never-leaves-the-server list,
 * instantiated: an account id, a broker account display name (on a prop
 * account this is a FIRM'S NAME — portfolio.ts:34-41), an email, and the user
 * id.
 */

import { readFileSync } from 'node:fs';

import {
  MAX_SHARE_ACCOUNT_NAME,
  buildDailyShareSnapshot,
  readDailyShareSnapshot,
  readPublicNickname,
  readShareVisibility,
  shareProvenanceNote,
  shareSnapshotLines,
  stopHeldOutcome,
  type ShareTradeRow,
  type ShareVisibility,
} from '../src/lib/share/snapshot';
import { isWellFormedShareToken, mintShareToken, readSharedCard } from '../src/lib/share/store';
import { DEMO_SHARE_TOKEN } from '../src/lib/demo/fixtures';

const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

function group(name: string) {
  console.log(`\n${name}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * The values that must never appear in a snapshot, with the names this suite
 * reports them under. Deliberately distinctive strings: a false negative here
 * would be a value so generic it appeared by coincidence.
 */
const SECRETS = {
  'user id': 'leakcheck-user-9f3a1c',
  'account id': 'leakcheck-account-7b2e44',
  /**
   * STILL A SECRET, AND THE DISTINCTION IS NOW THE WHOLE POINT.
   *
   * Account NAMES are published on purpose as of the 28.10 revision — but only
   * the ones the store resolved from the `accounts` table under the trader's
   * own RLS and handed in as `accounts: [{ id, label }]`. This value is a
   * `display_name` column sitting on a TRADE ROW, where it arrives through
   * `select('*')` and names an account nobody checked the ownership of. A
   * builder that spread the row would publish it.
   *
   * So the suite now asserts BOTH directions: this string must never appear,
   * and {@link PUBLISHED.account} must. One of them arriving by the other's
   * path is the bug.
   */
  'broker account display_name on a trade row': 'Topstep Evaluation 50K',
  'account nickname': 'leakcheck-nickname-portfolio',
  email: 'leakcheck@example.com',
  'broker trade key': 'live:leakcheck-884421',
  'symbol with contract month': 'MESZ5',
  'journal free text': 'leakcheck private trade reason',
} as const;

/**
 * The values that MUST appear — the other half of a leak suite, and new here.
 *
 * A test that only checks for absence passes perfectly on a builder that emits
 * nothing at all. Now that a field was deliberately moved from "never leaves
 * the server" to "always published", the suite has to pin the new behaviour as
 * hard as it pins the old one, or the next person cannot tell the difference
 * between the decision and a regression.
 */
const PUBLISHED = {
  account: 'Main Futures',
  secondAccount: 'Eval 50K',
} as const;

/** The trader's own accounts, as the store resolves them before the builder. */
const OWN_ACCOUNTS = [
  { id: SECRETS['account id'], label: PUBLISHED.account },
  { id: 'leakcheck-account-second', label: PUBLISHED.secondAccount },
];

const DAY = '2026-10-27';
/** 18:00 Chicago on the 26th is inside the 27th's session. */
const INSIDE = '2026-10-27T15:00:00.000Z';

/**
 * A row carrying EVERY denied field, so the builder has something to leak.
 *
 * Typed loosely on purpose: `ShareTradeRow` does not declare `account_id`,
 * `trade_reason` or `broker_trade_key`, which is the point — those columns
 * exist on `trade_plans` and arrive through `select('*')`, and a builder that
 * spread the row would carry them whether the type mentions them or not.
 */
function dirtyRow(overrides: Record<string, unknown> = {}): ShareTradeRow {
  return {
    status: 'closed',
    exit_price: 5810,
    entry_price: 5800,
    direction: 'long',
    actual_pnl: 125,
    pnl_amount: 125,
    closed_at: INSIDE,
    submitted_at: INSIDE,
    followed_plan: true,
    moved_sl: false,
    user_id: SECRETS['user id'],
    account_id: SECRETS['account id'],
    broker_account_id: 1234567,
    broker_host: 'live',
    broker_trade_key: SECRETS['broker trade key'],
    display_name: SECRETS['broker account display_name on a trade row'],
    nickname: SECRETS['account nickname'],
    email: SECRETS.email,
    symbol: SECRETS['symbol with contract month'],
    plan_symbol: SECRETS['symbol with contract month'],
    trade_reason: SECRETS['journal free text'],
    post_trade_notes: SECRETS['journal free text'],
    debrief_answer: SECRETS['journal free text'],
    risk_amount: 400,
    stop_loss: 5790,
    ...overrides,
  } as ShareTradeRow;
}

const ALL_OFF: ShareVisibility = { nickname: false, balance: false };
const NICKNAME_ON: ShareVisibility = { nickname: true, balance: false };

// `async function main()` + `void main()` at the foot, which is
// scripts/accounts-check.ts' shape. Group 7 drives the real `readSharedCard`,
// which is async, and tsx compiles these scripts to CJS — where a top-level
// await is a transform error rather than a runtime one.
async function main() {

// ── 1. Nothing denied survives serialisation ────────────────────────────────

group('1. no denied field reaches the serialised snapshot');

for (const visibility of [ALL_OFF, NICKNAME_ON]) {
  const snapshot = buildDailyShareSnapshot({
    rows: [dirtyRow(), dirtyRow({ actual_pnl: -60, pnl_amount: -60, followed_plan: false })],
    day: DAY,
    visibility,
    publicNickname: 'ES Trader',
  });
  const json = JSON.stringify(snapshot);
  const lines = shareSnapshotLines(snapshot).join(' | ');
  const which = visibility.nickname ? 'nickname on' : 'nickname off';

  for (const [name, value] of Object.entries(SECRETS)) {
    check(
      `${which}: snapshot JSON does not contain the ${name}`,
      !json.includes(value),
      `found "${value}" in ${json}`
    );
    // THE RENDERED TEXT IS A SECOND SURFACE. A value could in principle reach
    // the lines a human reads without being a field in the document — through
    // a label, or a future field formatted into one — so both are searched.
    check(
      `${which}: preview text does not contain the ${name}`,
      !lines.includes(value),
      `found "${value}" in ${lines}`
    );
  }

  // The positive half: the allow-list did not simply drop everything.
  check(`${which}: the snapshot still carries the day`, snapshot.day === DAY);
  check(`${which}: the snapshot still counts the trades`, snapshot.trades === 2);
  check(`${which}: the snapshot still carries the money`, snapshot.pnl === 65);
}

// ── 1b. Account names: published by the resolved path, never by the row ─────

group('1b. account names are published, account ids are not');

{
  const snapshot = buildDailyShareSnapshot({
    rows: [
      dirtyRow(),
      dirtyRow({ actual_pnl: -60, pnl_amount: -60, account_id: 'leakcheck-account-second' }),
    ],
    day: DAY,
    visibility: ALL_OFF,
    accounts: OWN_ACCOUNTS,
  });
  const json = JSON.stringify(snapshot);
  const lines = shareSnapshotLines(snapshot).join(' | ');

  check('both accounts are itemised', snapshot.accounts.length === 2);
  check('the published name is in the JSON', json.includes(PUBLISHED.account));
  check('the published name is in the preview text', lines.includes(PUBLISHED.account));
  check('the second account is named too', json.includes(PUBLISHED.secondAccount));
  // The per-account money, and the fact that it still sums to the day.
  check('the winning account carries its own money',
    snapshot.accounts.find((a) => a.name === PUBLISHED.account)?.pnl === 125);
  check('the losing account carries its own money',
    snapshot.accounts.find((a) => a.name === PUBLISHED.secondAccount)?.pnl === -60);
  check('biggest account first', snapshot.accounts[0]?.name === PUBLISHED.account);
  check('the rows sum to the day', snapshot.accounts.reduce((s, a) => s + (a.pnl ?? 0), 0) === 65);

  // AND THE ID IS STILL NOT THERE. It is the key the names were looked up by,
  // so it is the one value most likely to be carried along by accident.
  check('the account id is still absent from the JSON',
    !json.includes(SECRETS['account id']));
  check('the account id is still absent from the preview',
    !lines.includes(SECRETS['account id']));
}

{
  // AN ID THE TRADER DOES NOT OWN RESOLVES TO NO NAME.
  //
  // `trade_plans`' RLS asks whose ROW it is, not whose ACCOUNT the id names
  // (figures.ts:152-162), so a crafted write can point a trader's own trade at
  // somebody else's account. On a public card that would mean printing a name
  // for an account they do not own — so the builder treats an unknown id as
  // unassigned and never looks it up.
  const snapshot = buildDailyShareSnapshot({
    rows: [dirtyRow({ account_id: 'leakcheck-account-SOMEBODY-ELSE' })],
    day: DAY,
    visibility: ALL_OFF,
    accounts: OWN_ACCOUNTS,
  });
  check('an unowned account id is not resolved to a name',
    snapshot.accounts.every((a) => a.name === 'Unassigned'));
  check('an unowned account id does not reach the JSON',
    !JSON.stringify(snapshot).includes('SOMEBODY-ELSE'));
}

{
  // NO ACCOUNTS HANDED IN — migration 037 absent, or the import gate shut.
  const snapshot = buildDailyShareSnapshot({ rows: [dirtyRow()], day: DAY, visibility: ALL_OFF });
  check('no account sources: the panel is empty, not invented',
    snapshot.accounts.length === 1 && snapshot.accounts[0]?.name === 'Unassigned');
  check('no account sources: the trade row display_name is still not published',
    !JSON.stringify(snapshot).includes(SECRETS['broker account display_name on a trade row']));
}

{
  // The name is BOUNDED. A prop-firm string carrying an account number is cut
  // before the digits that identify it — the only mitigation left on this
  // field now that the toggle is gone.
  const long = 'Topstep Evaluation 50K-884421-live-xyz';
  const snapshot = buildDailyShareSnapshot({
    rows: [dirtyRow({ account_id: 'leakcheck-account-long' })],
    day: DAY,
    visibility: ALL_OFF,
    accounts: [{ id: 'leakcheck-account-long', label: long }],
  });
  const name = snapshot.accounts[0]?.name ?? '';
  check('a long account name is truncated', name.length <= MAX_SHARE_ACCOUNT_NAME);
  check('the truncation drops the account number', !name.includes('884421'));
}

// The one field the toggle controls, in both directions.
{
  const off = buildDailyShareSnapshot({
    rows: [dirtyRow()],
    day: DAY,
    visibility: ALL_OFF,
    publicNickname: 'ES Trader',
  });
  const on = buildDailyShareSnapshot({
    rows: [dirtyRow()],
    day: DAY,
    visibility: NICKNAME_ON,
    publicNickname: 'ES Trader',
  });
  check('nickname off: no name in the document', off.nickname === null);
  check('nickname off: the name is not in the JSON either',
    !JSON.stringify(off).includes('ES Trader'));
  check('nickname on: the chosen name is published', on.nickname === 'ES Trader');

  // A trader who turned the toggle on but never chose a handle stays
  // anonymous rather than publishing an empty string.
  const blank = buildDailyShareSnapshot({
    rows: [dirtyRow()],
    day: DAY,
    visibility: NICKNAME_ON,
    publicNickname: '   ',
  });
  check('nickname on with a blank handle: still anonymous', blank.nickname === null);
}

// ── 1c. The live figure is never read, let alone published ──────────────────
//
// REF-108's broker open P&L is gated off at launch because NinjaTrader
// confirmed on 29.10 that an account-level unrealised figure falls under our
// Market Data denial and needs a CME licence. The share card is UNAFFECTED by
// that decision — it reports closed trades only — and this group is what makes
// "unaffected" a fact somebody checked rather than a sentence in a commit.
//
// IT ASSERTS THE READ, NOT JUST THE OUTPUT, and that is the whole reason it is
// worth adding on top of group 1. An absence assertion over the serialised
// document would also pass on a builder that read the figure and then dropped
// it — and a figure that has been read has been copied into a process that
// serialises things for a living. So the fixture supplies the field as an
// ACCESSOR that records every access: the only way `touched` stays empty is if
// no code path named the property at all.
//
// A spread of the row would therefore fail this group twice over: the getter
// fires AND the value lands in the JSON. That is the same hazard group 1 is
// built around, pointed at the one field whose publication is now a compliance
// matter rather than a privacy one.

group('1c. the live open figure is never read by the snapshot builder');

{
  /** Distinctive, so a leak cannot be a coincidence. See SECRETS' note. */
  const LIVE_FIGURE = 918_273.64;

  /**
   * Every spelling the figure has had, plus the ones a later stage might pick.
   *
   * `openPnl` is ours (lib/tradovate/positions.ts), `openPnL` is the broker's
   * on the snapshot body, and the three snake-cased ones are what a column
   * would be called if anybody ever persisted it. Naming all five costs
   * nothing and means the guard does not depend on the next person choosing
   * the same spelling we did.
   */
  const LIVE_KEYS = ['openPnl', 'openPnL', 'open_pnl', 'unrealized_pnl', 'live_pnl'];

  /** Which of those keys the builder touched. Must stay empty. */
  const touched: string[] = [];

  function withLiveFigure(overrides: Record<string, unknown> = {}): ShareTradeRow {
    const row = dirtyRow(overrides);
    for (const key of LIVE_KEYS) {
      // `enumerable` so a spread or an Object.entries() walk WOULD reach it —
      // a non-enumerable property would make this fixture pass by hiding.
      Object.defineProperty(row, key, {
        enumerable: true,
        configurable: true,
        get() {
          touched.push(key);
          return LIVE_FIGURE;
        },
      });
    }
    return row;
  }

  /** Every key in a document, at any depth. */
  function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
      for (const item of value) keysOf(item, into);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        into.add(key);
        keysOf(inner, into);
      }
    }
    return into;
  }

  const snapshot = buildDailyShareSnapshot({
    // A closed row carrying the figure, and an OPEN one carrying it too. The
    // open row is the realistic shape — a live figure only exists while a
    // position is open — and `countedShareTrades` drops it on `status` and
    // `exit_price`, so it is also the assertion that an open position cannot
    // reach this card by any route.
    rows: [
      withLiveFigure(),
      withLiveFigure({ status: 'open', exit_price: null, actual_pnl: null, pnl_amount: null }),
    ],
    day: DAY,
    visibility: NICKNAME_ON,
    publicNickname: 'ES Trader',
  });
  const json = JSON.stringify(snapshot);
  const lines = shareSnapshotLines(snapshot).join(' | ');

  check(
    'the builder never reads a live-figure field',
    touched.length === 0,
    `read ${[...new Set(touched)].join(', ')}`
  );
  check(
    'no live-figure key reaches the document',
    [...keysOf(snapshot)].filter((key) => /open.?pnl|unreal|live.?pnl/i.test(key)).length === 0,
    [...keysOf(snapshot)].join(', ')
  );
  check('the figure is not in the JSON', !json.includes('918273') && !json.includes('918,273'));
  check('the figure is not in the preview text',
    !lines.includes('918273') && !lines.includes('918,273'));

  // THE POSITIVE HALF, group 1's rule: an absence suite passes perfectly on a
  // builder that emits nothing. The closed row's REALISED money is published,
  // the open row is not counted, and that pair is the whole claim — "closed
  // trades only" rather than "no money at all".
  check('the closed row is still counted', snapshot.trades === 1);
  check('and its realised money is still published', snapshot.pnl === 125);
}

// ── 2. The provenance tag, per case ─────────────────────────────────────────

group('2. provenance');

{
  const broker = (o: Record<string, unknown> = {}) => dirtyRow({ source: 'tradovate', ...o });
  const manual = (o: Record<string, unknown> = {}) => dirtyRow({ source: 'manual', ...o });

  const of = (rows: ShareTradeRow[]) =>
    buildDailyShareSnapshot({ rows, day: DAY, visibility: ALL_OFF }).provenance;

  check('all broker rows → broker', of([broker(), broker()]) === 'broker');
  check('all manual rows → manual', of([manual(), manual()]) === 'manual');
  check('one of each → mixed', of([broker(), manual()]) === 'mixed');

  // A row from a pre-034 database carries NO `source` key at all. It must read
  // as manual, not as broker — and not as a crash.
  const noKey = dirtyRow();
  delete (noKey as Record<string, unknown>).source;
  check('a row with no source key → manual', of([noKey]) === 'manual');
  check('no source key, mixed with a broker row → mixed', of([noKey, broker()]) === 'mixed');

  // THE EMPTY DAY. `broker === total` is `0 === 0`, so a naive "every row is a
  // broker row" test answers 'broker' here and puts a verification tag on a
  // card with nothing on it.
  check('no trades at all → manual, never broker', of([]) === 'manual');

  check(
    'broker prints the fee qualifier',
    shareProvenanceNote('broker') === 'Broker-synced · before fees'
  );
  check(
    'mixed makes no verification claim and no fee claim',
    shareProvenanceNote('mixed') === 'Partially broker-synced'
  );
  check('manual prints no tag at all', shareProvenanceNote('manual') === null);
  check(
    'no tag says "verified"',
    !['broker', 'mixed'].some((p) =>
      (shareProvenanceNote(p as 'broker' | 'mixed') ?? '').toLowerCase().includes('verif')
    )
  );
}

// ── 3. The discipline fractions have honest denominators ────────────────────

group('3. discipline fractions');

{
  const build = (rows: ShareTradeRow[]) =>
    buildDailyShareSnapshot({ rows, day: DAY, visibility: ALL_OFF });

  // Unanswered rows are in NEITHER half — not in the numerator (which would
  // credit a trade with no evidence) and not in the denominator (which would
  // charge for one).
  const mixedPlan = build([
    dirtyRow({ followed_plan: true }),
    dirtyRow({ followed_plan: false }),
    dirtyRow({ followed_plan: null }),
  ]);
  check(
    'followed_plan counts only the rows that answered',
    mixedPlan.followedPlan?.met === 1 && mixedPlan.followedPlan?.answered === 2,
    JSON.stringify(mixedPlan.followedPlan)
  );

  // Nothing answered → null, NEVER {met:0, answered:0} and never a zero score.
  const noPlan = build([dirtyRow({ followed_plan: null }), dirtyRow({ followed_plan: null })]);
  check('no row answered followed_plan → null, not a zero', noPlan.followedPlan === null);

  const noStop = build([
    dirtyRow({ moved_sl: null, stop_history: null }),
    dirtyRow({ moved_sl: null, stop_history: null }),
  ]);
  check('no row answered the stop question → null, not a zero', noStop.stopHeld === null);

  // ── stopHeldOutcome, the judgement call, case by case ──
  const stop = (history: unknown, movedSl: boolean | null = null) =>
    stopHeldOutcome(dirtyRow({ stop_history: history, moved_sl: movedSl }));

  check("verdict 'kept' → held", stop({ verdict: 'kept' }) === true);
  check(
    "verdict 'moved' + widened → NOT held",
    stop({ verdict: 'moved', direction: 'widened' }) === false
  );
  check(
    "verdict 'moved' + mixed → NOT held (one widening is the thing measured)",
    stop({ verdict: 'moved', direction: 'mixed' }) === false
  );
  // Imri, 19.10: "a trader who moves a stop TOWARD the profit is managing
  // risk, not breaking discipline."
  check(
    "verdict 'moved' + tightened → held",
    stop({ verdict: 'moved', direction: 'tightened' }) === true
  );
  // THE TWO THAT MUST NOT BE COUNTED. 'none' is a trade taken with no stop at
  // all, and crediting it would be the most flattering thing this card could
  // say; 'unknown' is our own read failing, and must not read as 'kept'.
  check("verdict 'none' → not counted, NOT held", stop({ verdict: 'none' }) === null);
  check("verdict 'unknown' → not counted, NOT held", stop({ verdict: 'unknown' }) === null);
  check(
    "verdict 'none' is not rescued by a self-report either",
    stop({ verdict: 'none' }, false) === null
  );

  // No document at all → the trader's own answer, which is coarser and counts
  // any move against.
  check('no document, moved_sl false → held', stop(null, false) === true);
  check('no document, moved_sl true → NOT held', stop(null, true) === false);
  check('no document, moved_sl null → not counted', stop(null, null) === null);
  check('unreadable document falls back to the self-report', stop({ verdict: 'nonsense' }, false) === true);

  const stopFraction = build([
    dirtyRow({ stop_history: { verdict: 'kept' } }),
    dirtyRow({ stop_history: { verdict: 'moved', direction: 'widened' } }),
    dirtyRow({ stop_history: { verdict: 'none' } }),
    dirtyRow({ stop_history: { verdict: 'unknown' } }),
  ]);
  check(
    'a day of kept/widened/none/unknown reads 1 of 2',
    stopFraction.stopHeld?.met === 1 && stopFraction.stopHeld?.answered === 2,
    JSON.stringify(stopFraction.stopHeld)
  );
}

// ── 4. Money, counts and the empty day ─────────────────────────────────────

group('4. money and counts');

{
  const build = (rows: ShareTradeRow[]) =>
    buildDailyShareSnapshot({ rows, day: DAY, visibility: ALL_OFF });

  const empty = build([]);
  check('an empty day carries no money rather than zero', empty.pnl === null);
  check('an empty day has no best or worst', empty.best === null && empty.worst === null);
  check('an empty day counts nothing', empty.trades === 0 && empty.wins === 0 && empty.losses === 0);
  check('an empty day still names itself', empty.day === DAY);

  // A day of closed trades that recorded NO amount is not a breakeven day.
  const unpriced = build([
    dirtyRow({ actual_pnl: null, pnl_amount: null }),
    dirtyRow({ actual_pnl: null, pnl_amount: null }),
  ]);
  check('closed trades with no amount → pnl null, not $0', unpriced.pnl === null);
  check('…but they are still counted as trades', unpriced.trades === 2);

  const mixedMoney = build([
    dirtyRow({ actual_pnl: 300, pnl_amount: 300 }),
    dirtyRow({ actual_pnl: -120, pnl_amount: -120 }),
    dirtyRow({ actual_pnl: null, pnl_amount: null }),
  ]);
  check('the sum is over the priced rows only', mixedMoney.pnl === 180);
  check('best and worst are money only', mixedMoney.best === 300 && mixedMoney.worst === -120);
  check('wins and losses partition the counted trades',
    mixedMoney.wins + mixedMoney.losses === mixedMoney.trades);

  // Open rows, unpriced rows and deleted rows are not the day.
  const filtered = build([
    dirtyRow(),
    dirtyRow({ status: 'open', exit_price: null }),
    dirtyRow({ status: 'closed', exit_price: null }),
    dirtyRow({ hidden: true }),
    dirtyRow({ closed_at: '2026-10-20T15:00:00.000Z', submitted_at: '2026-10-20T15:00:00.000Z' }),
  ]);
  check('only the closed, priced, visible rows of THIS day are counted',
    filtered.trades === 1, `counted ${filtered.trades}`);

  // A trade opened long before it closed is dated by its CLOSE, which is why
  // the store's SQL lookback is wider than the day.
  const carried = build([
    dirtyRow({ submitted_at: '2026-08-01T13:00:00.000Z', closed_at: INSIDE }),
  ]);
  check('a position opened months earlier is dated by its close', carried.trades === 1);
}

// ── 5. The defensive readers ───────────────────────────────────────────────

group('5. readers');

{
  check('a null snapshot reads as null', readDailyShareSnapshot(null) === null);
  check('an array is not a snapshot', readDailyShareSnapshot([1, 2]) === null);
  check('a snapshot with no day is refused', readDailyShareSnapshot({ pnl: 10 }) === null);
  check('a malformed day is refused', readDailyShareSnapshot({ day: '27/10/2026' }) === null);

  const round = readDailyShareSnapshot(
    JSON.parse(JSON.stringify(buildDailyShareSnapshot({
      rows: [dirtyRow()], day: DAY, visibility: NICKNAME_ON, publicNickname: 'ES Trader',
    })))
  );
  check('a built snapshot survives a round trip', round !== null && round.day === DAY);
  check('…with its fraction intact', round?.followedPlan?.answered === 1);
  check('…and its name', round?.nickname === 'ES Trader');

  // An unknown field does not travel. A reader that passed unknown keys
  // through would republish a field it does not understand.
  const extra = readDailyShareSnapshot({ day: DAY, provenance: 'manual', secretExtra: SECRETS.email });
  check('an unknown key is not copied through',
    extra !== null && !JSON.stringify(extra).includes(SECRETS.email));

  // A zero denominator is not a fraction.
  check('a zero-denominator fraction reads as null',
    readDailyShareSnapshot({ day: DAY, followedPlan: { met: 0, answered: 0 } })?.followedPlan === null);
  // An impossible pair is clamped rather than published as-is.
  check('met above answered is clamped',
    readDailyShareSnapshot({ day: DAY, stopHeld: { met: 9, answered: 2 } })?.stopHeld?.met === 2);

  // An unreadable provenance must resolve to the state that prints NO tag.
  check('an unknown provenance reads as manual',
    readDailyShareSnapshot({ day: DAY, provenance: 'verified-by-us' })?.provenance === 'manual');

  // Visibility is fail-closed in every direction: showing MORE than the trader
  // agreed to is the one error this column must not make.
  check('visibility of null is all false',
    Object.values(readShareVisibility(null)).every((v) => v === false));
  check('a string "true" is not consent',
    readShareVisibility({ nickname: 'true' }).nickname === false);
  check('a 1 is not consent', readShareVisibility({ nickname: 1 }).nickname === false);
  check('an actual true is consent', readShareVisibility({ nickname: true }).nickname === true);

  check('a nickname is trimmed and collapsed',
    readPublicNickname('  ES   Trader \n') === 'ES Trader');
  check('a nickname is bounded', (readPublicNickname('x'.repeat(200)) ?? '').length === 24);
  check('a non-string nickname is null', readPublicNickname({ name: 'x' }) === null);
}

// ── 6. Tokens ──────────────────────────────────────────────────────────────

group('6. tokens');

{
  const token = mintShareToken();
  check('a minted token is URL-safe and long enough', isWellFormedShareToken(token), token);
  check('a minted token is 43 chars (256 bits, base64url)', token.length === 43, `${token.length}`);
  check('two tokens differ', mintShareToken() !== mintShareToken());

  check('a short token is refused', !isWellFormedShareToken('short'));
  check('a 23-char token is refused', !isWellFormedShareToken('a'.repeat(23)));
  check('a 24-char token is accepted', isWellFormedShareToken('a'.repeat(24)));
  check('padding and slashes are refused', !isWellFormedShareToken('a'.repeat(24) + '+/='));
  check('a path traversal is refused', !isWellFormedShareToken('../'.repeat(10) + 'etc'));
  check('an absurdly long token is refused', !isWellFormedShareToken('a'.repeat(500)));

  // Mirrors migration 043's daily_shares_token_shape_check, so the two cannot
  // disagree about what a token is.
  check('the demo fixture token is well formed', isWellFormedShareToken(DEMO_SHARE_TOKEN));
}

// ── 7. A revoked token is not found ────────────────────────────────────────

group('7. the public reader');

{
  /**
   * A recording stand-in for the one query `readSharedCard` makes.
   *
   * Hand-built over an in-memory array, which is scripts/accounts-check.ts'
   * approach and for the same reason: the guarantee being tested lives in the
   * FILTERS, so the stub has to apply them rather than assert that they were
   * requested. `.is('revoked_at', null)` is what makes a revoked card
   * unreachable, and a stub that ignored it would pass whatever the reader did.
   */
  function stubClient(rows: Record<string, unknown>[]) {
    const seen: { columns?: string; filters: string[] } = { filters: [] };
    const query = {
      select(columns: string) {
        seen.columns = columns;
        return query;
      },
      eq(column: string, value: unknown) {
        seen.filters.push(`eq:${column}`);
        rows = rows.filter((r) => r[column] === value);
        return query;
      },
      is(column: string, value: unknown) {
        seen.filters.push(`is:${column}`);
        rows = rows.filter((r) => (r[column] ?? null) === value);
        return query;
      },
      async maybeSingle() {
        return { data: rows[0] ?? null, error: null };
      },
    };
    return {
      seen,
      client: { from: () => query } as unknown as Parameters<typeof readSharedCard>[1] extends
        { client?: infer C } ? C : never,
    };
  }

  const liveToken = 'a'.repeat(30);
  const revokedToken = 'b'.repeat(30);
  const goodSnapshot = buildDailyShareSnapshot({
    rows: [dirtyRow()],
    day: DAY,
    visibility: ALL_OFF,
  });

  const table = () => [
    { token: liveToken, trading_day: DAY, snapshot: goodSnapshot, revoked_at: null },
    {
      token: revokedToken,
      trading_day: DAY,
      snapshot: goodSnapshot,
      revoked_at: '2026-10-27T20:00:00.000Z',
    },
  ];

  {
    const { client, seen } = stubClient(table());
    const card = await readSharedCard(liveToken, { client });
    check('a live token resolves to its card', card !== null && card.snapshot.day === DAY);
    check('the public read filters on revoked_at', seen.filters.includes('is:revoked_at'),
      seen.filters.join(','));
    // The column list is the public path's whole containment. `user_id` here
    // would be a row identifier one JSON.stringify away from a page.
    check('the public read names only three columns',
      seen.columns === 'snapshot,revoked_at,trading_day', String(seen.columns));
    check('the public read does not select user_id', !(seen.columns ?? '').includes('user_id'));
  }

  {
    const { client } = stubClient(table());
    check('A REVOKED TOKEN IS NOT FOUND', (await readSharedCard(revokedToken, { client })) === null);
  }
  {
    const { client } = stubClient(table());
    check('an unknown but well-formed token is not found',
      (await readSharedCard('c'.repeat(30), { client })) === null);
  }
  {
    // Refused before any query is made, so garbage in a path segment never
    // becomes database work.
    const { client, seen } = stubClient(table());
    check('a malformed token is not found', (await readSharedCard('../../etc', { client })) === null);
    check('…and never reached the database', seen.filters.length === 0);
  }
  {
    // A row whose snapshot will not parse is the fourth case that must answer
    // the same 404 as the other three.
    const { client } = stubClient([
      { token: liveToken, trading_day: DAY, snapshot: { nonsense: true }, revoked_at: null },
    ]);
    check('a row with an unreadable snapshot is not found',
      (await readSharedCard(liveToken, { client })) === null);
  }
}

// ── 8. The translation suite actually exercises the route ──────────────────

group('8. the translation suite tests the share route, not a redirect');

{
  // THE SILENT FAILURE THIS GUARDS (REF-125 §8.2): translation-check.mjs holds
  // literal paths and cannot import TypeScript, so nothing but this assertion
  // ties its route to the fixture token. Get them out of step and the suite
  // visits a 404 page, finds no error boundary, and passes green while testing
  // nothing.
  const suite = readFileSync(new URL('./translation-check.mjs', import.meta.url), 'utf8');
  check(
    'translation-check.mjs lists a /demo/share route',
    /['"]\/demo\/share\//.test(suite),
    'no /demo/share route in ROUTES'
  );
  check(
    'that route uses the current fixture token',
    suite.includes(`/demo/share/${DEMO_SHARE_TOKEN}`),
    `expected /demo/share/${DEMO_SHARE_TOKEN}`
  );

  // And the proxy lets both paths through, which is the other half of §8.2.
  const proxy = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
  check(
    "proxy.ts lists '/share' as a public route",
    proxy.includes("pathname.startsWith('/share')"),
    'without this every logged-out visitor is redirected to /login'
  );
  check(
    "proxy.ts lists 'share' as a demo section",
    /DEMO_SECTIONS[\s\S]{0,400}'share'/.test(proxy),
    'without this /demo/share bounces to /demo/dashboard'
  );
}

// ── Report ─────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.log(`share-leak-check FAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('share-leak-check: ok');
console.log(`  ${Object.keys(SECRETS).length} denied values absent from the JSON and the preview text`);
console.log('  account NAMES published on purpose; account IDs still never, and an unowned id resolves to none');
console.log('  provenance per case, including the empty day that must not read as broker');
console.log("  stop discipline excludes 'none' and 'unknown'; a tightening counts as held");
console.log('  readers fail closed; tokens match migration 043\'s CHECK');
console.log('  a revoked token is not found, and the public read names three columns');
console.log('  the translation suite exercises the share route rather than a redirect');

}

void main();
