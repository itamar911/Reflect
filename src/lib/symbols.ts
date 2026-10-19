/**
 * Instrument roots: what a trader typed, what the broker sent, and whether the
 * two are the same product (REF-107).
 *
 * PURE AND BROWSER-SAFE, for the same reason lib/tradovate/match.ts is: the
 * import answers this question on the server to decide whether to write onto a
 * plan, and the confirmation screen answers it in the browser to list the
 * candidates for a row that was queued. One rule, one module, two callers.
 *
 *
 * THE TWO SIDES ARE DIFFERENT LANGUAGES AND DO NOT SHARE A PARSER
 * ---------------------------------------------------------------
 *
 * This is the whole point of the module, and the bug that produced it:
 *
 *   - A BROKER symbol is machine-generated. Tradovate sends `<ROOT><MONTH><YEAR>`
 *     — `MNQZ6`, `ESH7` — and nothing else. {@link brokerSymbolRoot} reads that
 *     shape and only that shape.
 *   - A PLAN symbol is free text a human typed into a box (TradePlanForm). It is
 *     `NQ`, or `NQ1`, or `NQ1!` off a TradingView chart, or `/NQ` off
 *     thinkorswim. {@link planSymbolRoot} strips those human decorations BEFORE
 *     it will consider reading the string as a contract name.
 *
 * Shape alone cannot tell the two apart, and that ambiguity is exactly what
 * broke: `NQ1` as a contract name reads as root `N` + month `Q` (August) + year
 * `1`, so a plan written `NQ1` was judged a different instrument from `MNQZ6`
 * and silently dropped — the trade sat in the confirmation queue with no
 * candidate to pick, and the screen offered only "not planned". Seven other
 * roots misparse the same way (`YM1`, `NG1`, `ZN1`, `HG1`, `ZF1`, `MNQ1`,
 * `MYM1`), all of them where the second letter happens to be a month code.
 *
 * Resolving by SIDE is what removes the guesswork. A trader typing a March-2021
 * contract into a plan in 2026 is not a case worth preserving; a trader typing
 * the continuous contract their chart shows them is the common case.
 *
 *
 * WHY TABLES AND NOT MORE REGEX
 * -----------------------------
 *
 * tradovate/fills.ts states at length that there is NO NAME PARSING anywhere in
 * the pricing chain, because "spreads, options and continuous contracts all
 * carry names that such a rule reads wrongly". That warning is why the two
 * additions here are LISTS A READER CAN CHECK against the CME product list —
 * {@link MICRO_TO_MINI} and {@link KNOWN_ROOTS} — and not another pattern that
 * guesses. Every function's failure mode is `null`, and null means the symbol
 * sits the decision out rather than contradicting anything.
 */

/** The twelve CME month codes, in the order the exchange lists them. */
const MONTH_CODES = 'FGHJKMNQUVXZ';

/**
 * A standard contract name: root, month code, one or two year digits.
 *
 * The root admits a digit after the first character so that `M2KZ6` (micro
 * Russell) parses; it may not START with one, which keeps the month code from
 * being read as the root of something like `Z6`.
 */
const CONTRACT_NAME = new RegExp(`^([A-Z][A-Z0-9]{0,3})[${MONTH_CODES}]\\d{1,2}$`);

/**
 * A bare root with no expiry, which is what a trader usually types.
 *
 * LETTERS ONLY, DELIBERATELY. Roots carrying a digit (`M2K`, `6E`, `6J`) are
 * admitted one at a time through {@link KNOWN_ROOTS} instead, because a shape
 * that accepted any digit would also accept `ZC1` and `NQ2` — the continuous
 * forms this module exists to strip — and would read them as roots in their own
 * right.
 */
const BARE_ROOT = /^[A-Z]{1,4}$/;

/**
 * Micro contract root → the mini it is the same instrument as.
 *
 * THE RULE THIS REPLACES WAS AN ACCIDENT. The old test was "one root is a tail
 * of the other", which gets `MNQ`/`NQ` and `MES`/`ES` right by coincidence of
 * spelling and gets `SIL`/`SI` wrong (micro silver does not end in `SI`) and
 * `M2K`/`RTY` wrong (micro Russell shares no letters with its mini at all).
 * `SIL` was a live false conflict in production, in the same silent direction
 * as the `NQ1` bug, and nobody had reported it.
 *
 * A trader who writes the mini and trades the micro has not contradicted
 * themselves — that is §B's own example — so both sides are reduced to the mini
 * before they are compared. Adding a pair is adding one line here, and the line
 * is checkable against the exchange's product list rather than inferred from a
 * string operation.
 */
const MICRO_TO_MINI: Readonly<Record<string, string>> = {
  MNQ: 'NQ',
  MES: 'ES',
  MYM: 'YM',
  M2K: 'RTY',
  MGC: 'GC',
  MCL: 'CL',
  SIL: 'SI',
};

/**
 * Roots this module recognises by name.
 *
 * It has exactly two jobs, and neither of them is to gate what may match:
 *
 *   1. It decides whether a trailing `1`/`2` on a PLAN symbol is a
 *      continuous-contract marker or part of a contract name — `NQ1` is `NQ`
 *      because `NQ` is a root we know, while `ESH2` keeps its contract reading
 *      and resolves to `ES`.
 *   2. It lets a root that carries a digit (`M2K`) through a shape test that is
 *      otherwise letters-only.
 *
 * An unknown root is not refused: it still resolves through the contract and
 * bare-root readings below. This list only makes the ambiguous cases certain.
 */
const KNOWN_ROOTS: ReadonlySet<string> = new Set([
  // Equity index
  'ES', 'NQ', 'YM', 'RTY',
  // Metals
  'GC', 'SI', 'HG', 'PL', 'PA',
  // Energy
  'CL', 'NG', 'RB', 'HO',
  // Rates
  'ZN', 'ZF', 'ZB', 'ZT',
  // Grains
  'ZC', 'ZS', 'ZW', 'ZL', 'ZM',
  // Crypto
  'BTC', 'ETH',
  // Every micro in the table above is a root in its own right.
  ...Object.keys(MICRO_TO_MINI),
]);

/** Whether a string can stand alone as a root. See {@link BARE_ROOT}. */
function isRootShape(name: string): boolean {
  return BARE_ROOT.test(name) || KNOWN_ROOTS.has(name);
}

/**
 * A plan symbol with its human decorations removed: uppercased, trimmed, and
 * with a leading `/` (thinkorswim, tastytrade) dropped.
 *
 * The form already uppercases on every keystroke; this does not trust it to,
 * because the column is also written by the broker merge and read from rows
 * stored before the form did.
 */
function normalisePlanSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/^\/+/, '');
}

/**
 * The same string without a trailing continuous-contract marker: `1`, `2`,
 * `1!`, `2!` or a bare `!`.
 *
 * TradingView writes the front month as `NQ1!` and traders shorten it to `NQ1`;
 * `2`/`2!` is the second month. Returns the input unchanged when there is
 * nothing to strip, and the caller compares the two to know whether a marker
 * was there at all.
 */
function stripContinuousMarker(name: string): string {
  const withoutBang = name.endsWith('!') ? name.slice(0, -1) : name;
  if (withoutBang.length > 1 && /[12]$/.test(withoutBang)) {
    return withoutBang.slice(0, -1);
  }
  return withoutBang;
}

/**
 * The root of a symbol a TRADER TYPED, or null when nothing can be read off it.
 *
 * Four readings, in this order, and the order is the fix:
 *
 *   1. **A known root under a continuous marker.** `NQ1` → `NQ`, `MNQ1` → `MNQ`.
 *      This runs FIRST because the contract reading of those strings is wrong
 *      but well-formed: `NQ1` parses as `N`+`Q`+`1` and `MNQ1` as `MN`+`Q`+`1`,
 *      and no later check could tell either of them from a real name.
 *   2. **A contract name**, when the root is at least two characters. `ESH2` →
 *      `ES`, `MNQZ6` → `MNQ`. The two-character floor is the generalisation of
 *      the bug: a single-letter root is almost always a misread of a root whose
 *      second letter is a month code, and on the plan side it is never worth the
 *      silent false conflict it causes.
 *   3. **A bare root as typed.** `NQ`, `M2K`.
 *   4. **An unknown root under a continuous marker.** `ZC1` → `ZC`, reached only
 *      when nothing above fit, so a real contract name never lands here.
 *
 * Anything else — a spread leg, an option name, anything with a space — is
 * null, and null sits the decision out entirely.
 */
export function planSymbolRoot(symbol: string | null | undefined): string | null {
  if (typeof symbol !== 'string') return null;
  const name = normalisePlanSymbol(symbol);
  if (name === '') return null;

  const bare = stripContinuousMarker(name);
  const decorated = bare !== name;

  if (decorated && KNOWN_ROOTS.has(bare)) return bare;

  const contract = CONTRACT_NAME.exec(name);
  if (contract && contract[1].length >= 2) return contract[1];

  if (isRootShape(name)) return name;
  if (decorated && isRootShape(bare)) return bare;

  return null;
}

/**
 * The root of a symbol THE BROKER SENT, or null when nothing can be read off it.
 *
 * Tradovate names a contract `<ROOT><MONTH><YEAR>` and nothing else, so this is
 * the narrow reading and stays narrow: no continuous markers, no leading slash,
 * no two-character floor — `CZ6` really is corn from this side. The bare-root
 * reading is kept only because the column is nullable free text in storage and
 * a hand-fixed row should still be readable.
 */
export function brokerSymbolRoot(symbol: string | null | undefined): string | null {
  if (typeof symbol !== 'string') return null;
  const name = symbol.trim().toUpperCase();
  if (name === '') return null;

  const contract = CONTRACT_NAME.exec(name);
  if (contract) return contract[1];
  return isRootShape(name) ? name : null;
}

/**
 * The root reduced to the one instrument it trades, with micros folded into
 * their minis. `MNQ` → `NQ`, `SIL` → `SI`, `M2K` → `RTY`; anything not in
 * {@link MICRO_TO_MINI} is already canonical and comes back unchanged.
 *
 * Null in, null out — an unreadable symbol stays unreadable.
 */
export function canonicalRoot(root: string | null | undefined): string | null {
  if (typeof root !== 'string' || root === '') return null;
  return MICRO_TO_MINI[root] ?? root;
}

/** The instrument a plan's free-text symbol names, as a canonical root. */
export function planInstrument(symbol: string | null | undefined): string | null {
  return canonicalRoot(planSymbolRoot(symbol));
}

/** The instrument a broker contract name names, as a canonical root. */
export function brokerInstrument(symbol: string | null | undefined): string | null {
  return canonicalRoot(brokerSymbolRoot(symbol));
}
