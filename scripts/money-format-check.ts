/**
 * Money formatter regression suite (REF-99).
 *
 * src/lib/money.ts is the single place a trading amount gets its currency
 * symbol and its digit grouping, and it is reached from the journal, the
 * dashboard, the stats page, the calendar, the P&L chart, the trade form's
 * context panel, the setups page and every rule-violation message. A change
 * there is a change to all of them at once, which is the point of the module
 * and also the reason it is worth pinning down.
 *
 * What this covers, and why each group is here:
 *   - the currency is a dollar and never a shekel — the whole ticket
 *   - negatives, including the sign/symbol ORDER (-$2,000.00, never $-2,000.00)
 *   - thousands separators, at the 1000 boundary and above
 *   - decimals: fixed digit counts both ways, so a column lines up
 *   - zero, which takes no sign
 *   - the three sign modes and the two minus glyphs the app uses
 *   - RTL: the exact strings the Hebrew UI renders, asserted to be free of
 *     bidi control characters and to keep sign-symbol-digits in that order.
 *     A bare amount in RTL flow is the failure this codebase has hit twice
 *     (see TodayContextPanel's BIDI note); the formatter must not be the one
 *     introducing marks, because callers wrap it in dir="ltr" themselves.
 *   - non-finite input, which must not reach a user as "NaN"
 *
 * Usage: npm run test:money
 * Exits non-zero on the first failing group's summary.
 */
import {
  TRADING_CURRENCY,
  formatMoney,
  formatMoneyAbs,
  formatMoneyCompact,
} from '../src/lib/money';

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

// ── The currency itself ──────────────────────────────────────────────────────

group('currency is the dollar', [
  c('constant', TRADING_CURRENCY, '$'),
  c('no shekel in a positive', formatMoney(1).includes('₪') ? 'has ₪' : 'clean', 'clean'),
  c('no shekel in a negative', formatMoney(-1).includes('₪') ? 'has ₪' : 'clean', 'clean'),
  c('no shekel in zero', formatMoney(0).includes('₪') ? 'has ₪' : 'clean', 'clean'),
  c('no shekel in compact', formatMoneyCompact(-12345).includes('₪') ? 'has ₪' : 'clean', 'clean'),
]);

// ── Negatives, and the order of sign / symbol / digits ───────────────────────

group('negatives', [
  // The brief's example, and the single most-rendered string in the app.
  c('-2000', formatMoney(-2000), '-$2,000.00'),
  c('-0.5', formatMoney(-0.5), '-$0.50'),
  c('-1', formatMoney(-1), '-$1.00'),
  c('sign precedes symbol', formatMoney(-2000).startsWith('-$') ? 'ok' : formatMoney(-2000), 'ok'),
  c('symbol not after sign-digit', formatMoney(-2000).includes('$-') ? 'bad' : 'clean', 'clean'),
  // -0 is a real JavaScript value and reaching it from a sum is easy. It is
  // not a loss and must not be drawn as one.
  c('negative zero takes no sign', formatMoney(-0), '$0.00'),
]);

// ── Thousands separators ─────────────────────────────────────────────────────

group('thousands separators', [
  c('999 ungrouped', formatMoney(999), '+$999.00'),
  c('1000 grouped', formatMoney(1000), '+$1,000.00'),
  c('-1000 grouped', formatMoney(-1000), '-$1,000.00'),
  c('12345.67', formatMoney(12345.67), '+$12,345.67'),
  c('1234567.89', formatMoney(1234567.89), '+$1,234,567.89'),
  c('-1234567.89', formatMoney(-1234567.89), '-$1,234,567.89'),
  c('rounded keeps grouping', formatMoney(-1234567, { decimals: 0 }), '-$1,234,567'),
]);

// ── Decimals ─────────────────────────────────────────────────────────────────

group('decimals', [
  // Fixed digits BOTH ways: a trailing zero is padded in, and a long fraction
  // is rounded off, so amounts in a column have their points aligned.
  c('pads to 2', formatMoney(1250.5), '+$1,250.50'),
  c('rounds to 2', formatMoney(1250.567), '+$1,250.57'),
  c('integer pads to 2', formatMoney(1250), '+$1,250.00'),
  c('0 decimals rounds', formatMoney(1250.67, { decimals: 0 }), '+$1,251'),
  c('1 decimal', formatMoney(-12.34, { decimals: 1, minus: '−' }), '−$12.3'),
  c('dropFractionAtThousand under', formatMoney(999.5, { decimals: 1, dropFractionAtThousand: true }), '+$999.5'),
  c('dropFractionAtThousand at', formatMoney(1000.5, { decimals: 1, dropFractionAtThousand: true }), '+$1,001'),
]);

// ── Zero, and the sign modes ─────────────────────────────────────────────────

group('zero and sign modes', [
  c('zero has no sign', formatMoney(0), '$0.00'),
  c('zero, 0 decimals', formatMoney(0, { decimals: 0 }), '$0'),
  c('auto adds + on gain', formatMoney(250), '+$250.00'),
  c('negative-only mode, gain', formatMoney(250, { sign: 'negative' }), '$250.00'),
  c('negative-only mode, loss', formatMoney(-250, { sign: 'negative' }), '-$250.00'),
  c('none mode drops sign', formatMoney(-250, { sign: 'none' }), '$250.00'),
  c('none mode is magnitude', formatMoney(-2000, { sign: 'none' }), '$2,000.00'),
  c('typographic minus', formatMoney(-250, { minus: '−' }), '−$250.00'),
  c('ascii minus is default', formatMoney(-250), '-$250.00'),
]);

// ── The wrappers ─────────────────────────────────────────────────────────────

group('formatMoneyAbs', [
  c('loss becomes magnitude', formatMoneyAbs(-2000), '$2,000.00'),
  c('gain unsigned', formatMoneyAbs(2000), '$2,000.00'),
  c('zero', formatMoneyAbs(0), '$0.00'),
  c('threshold with fraction', formatMoneyAbs(1500.5), '$1,500.50'),
]);

group('formatMoneyCompact', [
  c('under 1k rounds', formatMoneyCompact(250.4), '$250'),
  c('under 1k negative', formatMoneyCompact(-250.4), '−$250'),
  c('1k gets one decimal', formatMoneyCompact(1200), '$1.2k'),
  c('negative 1k', formatMoneyCompact(-1200), '−$1.2k'),
  c('10k drops the decimal', formatMoneyCompact(12345), '$12k'),
  c('negative 10k', formatMoneyCompact(-12345), '−$12k'),
  c('no + on a gain', formatMoneyCompact(1200).includes('+') ? 'has +' : 'clean', 'clean'),
]);

// ── RTL / bidi ───────────────────────────────────────────────────────────────

// The app is Hebrew and dir="rtl" globally (src/app/layout.tsx). Callers
// isolate these strings in dir="ltr" spans; the formatter's job is to emit a
// clean LTR run and nothing else. Any bidi control character injected here
// would be invisible in review and would fight the caller's isolation.
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩؜]/;

const rtlSamples = [
  formatMoney(-2000),
  formatMoney(2000),
  formatMoney(0),
  formatMoneyAbs(-2000),
  formatMoneyCompact(-12345),
  formatMoney(-1234567.89),
];

group('RTL rendering', [
  // The brief's worked example, exactly as it appears inside a Hebrew sentence.
  c('-$2,000.00 verbatim', formatMoney(-2000), '-$2,000.00'),
  c('no bidi control marks', rtlSamples.some((s) => BIDI_MARKS.test(s)) ? 'has marks' : 'clean', 'clean'),
  // Logical order must be sign, then symbol, then digits — the order a
  // dir="ltr" run will display. If the symbol ever moved after the digits the
  // RTL page would render it at the far end of the number.
  c(
    'sign-symbol-digits order',
    /^[-−+]?\$[\d,]+(\.\d+)?k?$/.test(formatMoney(-1234567.89)) ? 'ok' : formatMoney(-1234567.89),
    'ok'
  ),
  c(
    'order holds for compact',
    /^[-−+]?\$[\d.,]+k?$/.test(formatMoneyCompact(-12345)) ? 'ok' : formatMoneyCompact(-12345),
    'ok'
  ),
  // Hebrew digits are never used for these amounts: en-US grouping only, so a
  // figure reads the same to a trader whatever their locale is set to.
  c('ascii digits only', /^[-−+]?\$[0-9,.]+$/.test(formatMoney(-1234567.89)) ? 'ok' : 'non-ascii digits', 'ok'),
]);

// ── Non-finite input ─────────────────────────────────────────────────────────

// A division by zero upstream must not surface in a P&L cell as "NaN", which
// reads like a number the user lost.
group('non-finite input', [
  c('NaN', formatMoney(Number.NaN), '—'),
  c('Infinity', formatMoney(Number.POSITIVE_INFINITY), '—'),
  c('-Infinity', formatMoney(Number.NEGATIVE_INFINITY), '—'),
  c('abs wrapper', formatMoneyAbs(Number.NaN), '—'),
  c('compact wrapper', formatMoneyCompact(Number.NaN), '—'),
]);

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('money formatter: all groups passed');
