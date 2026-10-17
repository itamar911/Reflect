#!/usr/bin/env node
/**
 * REF-113 Stage 0 self-check — does `--orders` leak anything?
 *
 *   node scripts/spike/orders-selfcheck.mjs
 *
 * NO CREDENTIALS, NO NETWORK. It drives the pure helpers of
 * ./tradovate-spike.mjs over synthetic entities built to look exactly like the
 * ones that would leak: distinctive prices, ids and timestamps whose digits
 * would be unmistakable in the output.
 *
 * WHY THIS EXISTS. The whole value of the Stage 0 report is that the owner can
 * read it, paste it into a ticket and not have published a trader's positions.
 * That is a property of `safeSample`, and a property is worth asserting rather
 * than believing — the same standard src/lib/tradovate/import.ts sets for
 * idempotence ("MEASURED, NOT ASSERTED").
 *
 * The second thing it pins is the direction of the default: a field NOBODY
 * listed must print as its type. A future author adding `avgFillPrice` to the
 * entity gets silence for free, and that is the only safe default.
 */

import {
  safeSample,
  fieldSurvey,
  changedFields,
  versionsByOrder,
  enumValues,
  VOCABULARY,
} from './tradovate-spike.mjs';

let failures = 0;
let checks = 0;

function c(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
  }
}

function group(title, fn) {
  console.log(`\n${title}`);
  fn();
}

// ── The synthetic entities ───────────────────────────────────────────────────
//
// Every value here is chosen to be GREPPABLE. If any of these digit strings
// reaches the report, the assertions below say so by name.

const SECRET_VALUES = [
  '5012.75', // a stop price
  '4987.25', // another stop price
  '2606306', // a contract id
  '884422', // an order id
  '991100', // a version id
  '2026-10-14T05:00:00Z', // an instant
  'ESZ6', // a contract name
];

const orderRow = {
  id: 884422,
  accountId: 777111,
  contractId: 2606306,
  timestamp: '2026-10-14T05:00:00Z',
  action: 'Sell',
  ordStatus: 'Canceled',
  ocoId: 884423,
  parentId: null,
  admin: false,
  external: false,
};

const version = (over = {}) => ({
  id: 991100,
  orderId: 884422,
  orderQty: 3,
  orderType: 'Stop',
  price: null,
  stopPrice: 5012.75,
  pegDifference: null,
  timeInForce: 'GTC',
  timestamp: '2026-10-14T05:00:00Z',
  text: 'ESZ6 protective',
  ...over,
});

// ── 1. Not one value escapes ─────────────────────────────────────────────────

group('the report cannot contain a price, an id, a timestamp or a symbol', () => {
  const survey = fieldSurvey([orderRow, version(), version({ stopPrice: 4987.25 })]);
  // Exactly what the script prints: the field name, the types, the sample.
  const rendered = [...survey.entries()]
    .map(([name, info]) => `${name} ${[...info.types].join('|')} ${info.sample}`)
    .join('\n');

  c(
    '(1) none of the seven greppable values appears in the rendered survey',
    SECRET_VALUES.filter((v) => rendered.includes(v)),
    []
  );
  c('(2) a price prints as its type', safeSample('stopPrice', 5012.75), '<number>');
  c('(3) an id prints as its type', safeSample('orderId', 884422), '<number>');
  c('(4) an instant prints as its type', safeSample('timestamp', '2026-10-14T05:00:00Z'), '<string>');
  c('(5) a quantity prints as its type', safeSample('orderQty', 3), '<number>');
  c('(6) free text prints as its type, even when short', safeSample('text', 'ESZ6 protective'), '<string>');
});

// ── 2. The vocabulary IS printed, because it is the measurement ──────────────

group('the enum vocabulary is printed, because that is what is being measured', () => {
  c('(1) ordStatus', safeSample('ordStatus', 'Canceled'), 'Canceled');
  c('(2) orderType', safeSample('orderType', 'TrailingStop'), 'TrailingStop');
  c('(3) action', safeSample('action', 'Sell'), 'Sell');
  c('(4) timeInForce', safeSample('timeInForce', 'GTC'), 'GTC');
  c('(5) a boolean flag is not trader data', [safeSample('admin', false), safeSample('x', true)], ['false', 'true']);
  c('(6) null stays null, so an ABSENT field is distinguishable from a hidden one', safeSample('price', null), 'null');
  c('(7) an array prints its length and nothing in it', safeSample('whatever', [1, 2, 3]), '<array len=3>');
});

// ── 3. Fail closed ───────────────────────────────────────────────────────────

group('fail closed: a field nobody listed prints as its type', () => {
  c('(1) a plausible future price field', safeSample('avgFillPrice', 5012.75), '<number>');
  c('(2) a plausible future id field', safeSample('executionProviderId', 42), '<number>');
  c('(3) `label` is in the vocabulary but free text in it still falls back', [
    safeSample('label', 'stop'),
    safeSample('label', 'my long ES scalp from the 5m open'),
  ], ['stop', '<string>']);
  c(
    '(4) a vocabulary field holding a NUMBER is not printed either',
    safeSample('ordStatus', 7),
    '<number>'
  );
  // Anchored on the SUFFIX, not a substring. `timeInForce` is an enum
  // (GTC/Day/IOC/FOK) and contains "time" while being nothing of the kind, so a
  // substring match here fails this assertion on a field that is safe — the
  // test would be the thing that is wrong.
  c(
    '(5) the vocabulary holds no price-, id-, instant- or quantity-shaped name',
    [...VOCABULARY].filter((f) => /(^|[a-z])Price$|^price$|^id$|Id$|^timestamp$|Time$|Date$|Qty$|^qty$/.test(f)),
    []
  );
});

// ── 4. The survey reads EVERY row, not row zero ──────────────────────────────

group('the field survey reads every row, which is the whole point for stopPrice', () => {
  // A limit order's version has no stopPrice at all; a stop's does. Read off
  // row zero only, the measurement would answer the opposite of the truth.
  const limitVersion = { id: 1, orderId: 2, orderType: 'Limit', price: 5000, timestamp: 't' };
  const stopVersion = { id: 3, orderId: 4, orderType: 'Stop', stopPrice: 4990, timestamp: 't' };

  const survey = fieldSurvey([limitVersion, stopVersion]);
  c('(1) stopPrice is found although the FIRST row lacks it', survey.has('stopPrice'), true);
  c('(2) and it is reported as present on 1 of 2 rows', survey.get('stopPrice').presentOn ?? survey.get('stopPrice').present, 1);
  c('(3) a field on every row says so', survey.get('orderType').present, 2);
  c('(4) both enum members survive to the vocabulary scan', enumValues([limitVersion, stopVersion], 'orderType'), ['Limit', 'Stop']);
});

// ── 5. The move detector's two primitives ────────────────────────────────────

group('changedFields and versionsByOrder answer Q2 with names, never values', () => {
  const v1 = version({ id: 1, timestamp: '2026-10-14T05:00:00Z' });
  const v2 = version({ id: 2, timestamp: '2026-10-14T05:30:00Z', stopPrice: 4987.25 });
  const changed = changedFields(v1, v2);

  c('(1) a moved stop shows up as a CHANGED FIELD NAME', changed.includes('stopPrice'), true);
  c('(2) and the id/timestamp that also moved are named, not valued', changed, ['id', 'stopPrice', 'timestamp']);
  c('(3) the names carry no value at all', SECRET_VALUES.filter((s) => changed.join(',').includes(s)), []);
  c('(4) an unchanged pair reports nothing', changedFields(v1, { ...v1 }), []);

  const grouped = versionsByOrder([v2, v1, { id: 9, orderId: 555, timestamp: 't' }]);
  c('(5) versions group by their order', [...grouped.keys()].sort(), [555, 884422]);
  c('(6) and arrive OLDEST FIRST, so v[0] is the initial stop', grouped.get(884422).map((v) => v.id), [1, 2]);
  c('(7) a version with no orderId is dropped rather than grouped under undefined', versionsByOrder([{ id: 1 }]).size, 0);
});

// ── 6. Equal timestamps: id breaks the tie, deterministically ────────────────

group('a tie on timestamp is broken by id, so the initial stop is never ambiguous', () => {
  const a = version({ id: 10, timestamp: '2026-10-14T05:00:00Z' });
  const b = version({ id: 11, timestamp: '2026-10-14T05:00:00Z' });
  c('(1) forwards', versionsByOrder([a, b]).get(884422).map((v) => v.id), [10, 11]);
  c('(2) backwards — same answer', versionsByOrder([b, a]).get(884422).map((v) => v.id), [10, 11]);
});

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
process.exit(failures === 0 ? 0 : 1);
