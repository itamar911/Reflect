/**
 * `?mode=fills` — REF-117 Stage 0. TEMPORARY, and delete it with the ticket.
 *
 * The same kind of block as ./q8.ts and under the same licence: a diagnostic
 * that answers one question the database cannot, written to be removed. q8's
 * header says "delete this after"; so does this one.
 *
 *
 * THE QUESTION, AND WHY SQL COULD NOT CLOSE IT
 * --------------------------------------------
 *
 * REF-117 case א: on 19.10 one entry order and one stop order on MNQZ6 produced
 * TWO journal rows, −$229 on two contracts and −$115 on one. The ticket guessed
 * that `/fillPair/list` splits one entry fill into two pairs carrying quantity
 * segments and that `groupIntoTrades` fails to notice they name the same
 * `fill.id`. **That cannot be what happened.** `groupIntoTrades`
 * (lib/tradovate/fills.ts) is a union-find over fill ids, so two pairs sharing a
 * `buyFillId` are welded into one trade by construction — and that exact case is
 * pinned by scripts/tradovate-today-check.ts (§A3 assertions 3 and 6: three
 * pairs sharing one entry fill must come out as one row of qty 3).
 *
 * So the only reading left is that BOTH legs filled in pieces — entry 2+1, exit
 * 2+1 — and Tradovate matched them pairwise, producing two pairs with no fill in
 * common at all. The two rows' `broker_trade_key`s are `…6001` and `…6003`,
 * and the key is the group's LOWEST fill id, so there really are two distinct
 * entry fills. The SQL could get that far and no further: both rows carry
 * `entry_price = 29853.75`, which is consistent with two entry fills that filled
 * at the same price and does not prove it. The same day's other account shows the
 * opposite case working — a row of qty 8 whose `entry_price` is 29749.84375, a
 * weighted mean, so several entry fills DID merge there.
 *
 * What separates the two is the SHAPE OF THE FILL GRAPH, which no column holds.
 * Hence this.
 *
 *
 * AND THEN THE FIRST RUN ANSWERED A DIFFERENT QUESTION (20.10, 09:00 UTC)
 * ----------------------------------------------------------------------
 *
 * `/fill/list` AND `/fillPair/list` BOTH RETURNED ZERO ROWS, on both hosts, with
 * `/position/list` returning one. The trader's 19.10 round trips are in the
 * journal, so those fills certainly existed — and they are not in the list any
 * more. That excludes the only reading under which the list carries history, and
 * it makes a liar of this module's own header one level down:
 * `src/lib/tradovate/fills.ts` says "`/fill/list` and `/fillPair/list` grow with
 * a trader's whole history because the API offers no way to ask for less". They
 * do not. They behave like `/order/list`, which REF-113 measured at
 * `depthDays = 0` and whose own type comment records that "the evening before
 * the measurement it returned zero rows".
 *
 * Three things in the product are built on the assumption that just died, and
 * none of them is reachable by a parameter: `BrokerDayRequest.windowStartMs`
 * (which widens PRICING only — the pull is unfiltered by design),
 * `IMPORT_LOOKBACK_MS` (48h, the nightly cron) and `MAX_SINCE_AGE_MS` (7 days,
 * the /trades route). A window cannot resurrect a row the list did not return.
 *
 * SO THIS MODE NOW ASKS A SECOND QUESTION, AND IT IS THE MORE URGENT ONE: is
 * there ANY endpoint that still reaches yesterday? The narrowing variants the
 * fills.ts header named and rejected on cost grounds are the only candidates —
 *
 *   /position/list                    → does IT carry past trading days?  (Q6)
 *   /fillPair/deps?masterid=<posId>   → that position's pairs             (Q7)
 *   /fill/items?ids=<fillIds>         → those pairs' fills                (Q7)
 *
 * — and if they do, the graph analysis below runs on what they return rather than
 * on an empty list, which is how Q1 gets its answer about 19.10 after all. Every
 * fill and pair this mode sees, whichever read produced it, goes into one graph;
 * `readVia` at the top of the response says which read found what.
 *
 *
 * WHAT IT MEASURES: GRAPH SHAPE, AND NOTHING ELSE
 * -----------------------------------------------
 *
 * Build the bipartite graph of (buy fills ↔ sell fills) with one edge per
 * `fillPair`, scoped to one `(account, contract, trading day)`. Then report two
 * numbers side by side:
 *
 *   components — what `groupIntoTrades` produces TODAY (union-find over fills)
 *   cycles     — what REF-117's definition produces (a netPos walk: flat → open
 *                → flat is one logical position)
 *
 * `components > cycles` IS THE BUG, counted. A group where today's grouping
 * splits one logical position into several trades reports it in one integer, and
 * {@link FillsHostReport.answers} totals them. Case א is `components: 2,
 * cycles: 1`.
 *
 * Per component it also reports `buyFills` and `sellFills`, so
 * `bothSidesInPieces` says in one boolean whether the suspected mechanism is
 * what actually happened.
 *
 *
 * NO PRICES, NO QUANTITIES, NO IDS, NO INSTANTS
 * ---------------------------------------------
 *
 * Every emitted number is a COUNT of rows or an INDEX, and every emitted value
 * besides those is a boolean. The rule is ./q8.ts' rule — "a distance is a
 * measurement, a level is an identifier" — applied to the other axis: a count of
 * fills is a measurement, a fill id is an identifier and a contract quantity is
 * the position.
 *
 * Three properties keep it that way:
 *
 *   - **Quantities are read, never reported.** The netPos walk needs `fill.qty`
 *     and the reconciliation needs `position.netPos`; neither leaves this file.
 *     What leaves is `endsFlat` and `reconcilesWithNetPos`, two booleans.
 *   - **Groups are an ARRAY, never an object keyed by account or contract.** An
 *     id-keyed map would put the ids in the response as JSON KEYS, which is the
 *     leak `scanForLeaks` checks object keys for. Position in the array is the
 *     only handle a reader gets.
 *   - **Days are a relative index, not a date.** `dayIndex: 0` is the most
 *     recent trading day present in `/fill/list`, `1` the one before it. Same
 *     reasoning as `relativeSeconds` in ./survey.ts: an offset is a
 *     measurement, an instant identifies when the trader was at their desk. With
 *     the probe run on 20.10, dayIndex 1 is 19.10 — which the owner knows and the
 *     response does not say.
 *
 * `depthDays` is the one fractional number here and it is deliberately OUTSIDE
 * the strict subtree, beside the field surveys, exactly where `?mode=orders`
 * puts its own. See `STRICT_SUBTREE_KEYS` in ../route.ts.
 *
 * NO MUTATION AND THREE NEW ENDPOINTS, all reads: `/fillPair/list` (which
 * lib/tradovate/fills.ts already calls on every day pull) plus
 * `/fillPair/deps` and `/fill/items` for the narrowing walk. `/fill/list` and
 * `/position/list` were on the allowlist already. See ./guard.ts, where each is
 * checked against the mutation denylist the same way the rest of that list was.
 */

import { callEndpoint, reportOf } from './call';
import { depthDays, fieldSurvey, hasField, looksTruncated, nonNullCount, rowTime, type Row } from './survey';

/** The questions, as the owner reads them at the top of the response. */
export const FILL_QUESTIONS = [
  'Q1  האם פוזיציה לוגית אחת מתפרקת היום לכמה עסקאות?',
  '      components = מה שה-union-find מייצר היום. cycles = מה שהגדרת REF-117 מייצרת.',
  '      components > cycles — זה הבאג, במספר שלם. מקרה א הוא 2 מול 1.',
  'Q2  האם גם הכניסה וגם היציאה התמלאו במנות (bothSidesInPieces)?',
  '      זו ההשערה היחידה שנשארה אחרי ש-SQL לא הכריע. buyFills>1 וגם sellFills>1.',
  'Q3  עד כמה אחורה מגיע /fill/list?',
  '      /order/list נמדד כ-0. אם למילויים אין עומק, בדיקת ההתאמה של §2.4 מחזיקה',
  '      כל עסקת סווינג, וזה משנה את הציפייה מ-Stage 1.',
  'Q4  האם finallyPaired קיים ואמיתי?',
  '      הוא ב-types.ts ואף אחד לא קורא אותו. אם אמיתי — דרך ישרה יותר לזהות',
  '      זנב פתוח מ-netPos.',
  'Q5  האם יש חציית אפס (היפוך פוזיציה) — ומחזור שנפתח בלי להיסגר?',
  '      שאלת המדידה של REF-107 §A4, פתוחה מאז. קובעת אם הפיצול הסינתטי נחוץ.',
  'Q6  האם /position/list מגיע לימי מסחר קודמים?',
  '      אם לא — אין שום ידית לאתמול, וכל הייבוא חייב לקרות בתוך המסחר.',
  'Q7  האם המסלול המצומצם מגיע למה ש-/fill/list לא?',
  '      /fillPair/deps?masterid=<positionId> ואז /fill/items?ids=. זו השאלה',
  '      שהריצה הראשונה פתחה: הרשימות חזרו ריקות ב-20.10 בבוקר.',
];

/**
 * How many trading days get reported.
 *
 * Five, so that 19.10 is reachable from a run on 20.10 with room to spare, and
 * bounded because the response is read by a person. The DEPTH of `/fill/list` is
 * reported separately (Q3) and is not limited by this — that measurement is
 * taken over the unfiltered response, or it would be measuring itself.
 */
const MAX_DAYS = 5;

/** How many `(account, contract, day)` groups get reported. Bounds the response. */
const MAX_GROUPS = 40;

/** How many components one group reports individually. The counts are totalled regardless. */
const MAX_COMPONENTS = 12;

/**
 * How many positions get a `/fillPair/deps` call.
 *
 * The same cap ./orders.ts puts on its own deps fan-out, for the same reason:
 * deps are one request per master, and Tradovate's limits are documented as
 * variable by hour, minute AND second, escalating to a `p-captcha` that a
 * third-party application cannot clear — the trader then waits about an hour and
 * the rule engine's day pull waits with them. A diagnostic is never worth that.
 *
 * Twelve is headroom rather than a limit expected to bite: the first run saw ONE
 * position row. If it ever caps, `capped: true` says so.
 */
const MAX_DEPS_POSITIONS = 12;

/**
 * How many fill ids go into one `/fill/items?ids=` call.
 *
 * A bound on URL length, not on quota — the ids are a comma-joined query
 * parameter and a trader with a busy day could otherwise build a request no
 * proxy will forward.
 */
const ITEMS_CHUNK = 80;

/** A fill, reduced to what the two measurements need. Nothing here is emitted. */
interface FillFacts {
  id: number;
  contractId: number;
  buy: boolean;
  qty: number;
  orderId: number;
  atMs: number | null;
  /** `year-month-day` off `fill.tradeDate`. Used to bucket; NEVER emitted. */
  dayKey: string | null;
  finallyPaired: unknown;
}

/** One edge of the graph: a `fillPair` whose position resolved to an account. */
interface Edge {
  buyFillId: number;
  sellFillId: number;
  accountId: number;
  contractId: number;
}

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `fill.tradeDate` as a bucket key, or null when the row stated nothing usable. */
function dayKeyOf(row: Row): string | null {
  const date = row['tradeDate'];
  if (!date || typeof date !== 'object') return null;
  const { year, month, day } = date as Record<string, unknown>;
  const y = int(year);
  const m = int(month);
  const d = int(day);
  return y === null || m === null || d === null ? null : `${y}-${m}-${d}`;
}

function fillFactsOf(row: Row): FillFacts | null {
  const id = int(row['id']);
  const contractId = int(row['contractId']);
  const qty = int(row['qty']);
  const action = row['action'];
  if (id === null || contractId === null || qty === null) return null;
  if (action !== 'Buy' && action !== 'Sell') return null;
  return {
    id,
    contractId,
    buy: action === 'Buy',
    qty: Math.abs(qty),
    orderId: int(row['orderId']) ?? 0,
    atMs: rowTime(row),
    dayKey: dayKeyOf(row),
    finallyPaired: row['finallyPaired'],
  };
}

/**
 * Union-find over fill ids — THE SAME ALGORITHM AS PRODUCTION, on purpose.
 *
 * A reimplementation rather than an import, and that is the one thing in this
 * file worth arguing. `groupIntoTrades` in lib/tradovate/fills.ts is not
 * exported, and exporting it to let a temporary diagnostic reach it would make a
 * product module answer to a file that is going to be deleted. What matters is
 * that the RULE is identical — two pairs merge iff they share a fill — and that
 * rule is six lines, reproduced here so a reader can check it against the
 * original without a build step.
 */
function componentsOf(edges: readonly Edge[]): Map<number, number[]> {
  const parent = new Map<number, number>();

  const find = (id: number): number => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };

  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const edge of edges) union(edge.buyFillId, edge.sellFillId);

  const groups = new Map<number, number[]>();
  for (const edge of edges) {
    const key = find(edge.buyFillId);
    const members = groups.get(key);
    if (members) members.push(edge.buyFillId, edge.sellFillId);
    else groups.set(key, [edge.buyFillId, edge.sellFillId]);
  }
  return groups;
}

/** What one component of the fill graph looked like. Counts and booleans only. */
interface ComponentReport {
  /** Edges: how many `fillPair` rows are in this component. */
  pairs: number;
  /** Distinct fills it touches. */
  fills: number;
  buyFills: number;
  sellFills: number;
  /** Distinct `orderId`s among those fills. An unusable 0 is not counted. */
  orders: number;
  /**
   * Both legs of THIS COMPONENT filled in pieces.
   *
   * NOT THE ANSWER TO Q2 — see {@link GroupReport.bothSidesInPieces}, which is.
   * In case א each component holds exactly one buy fill and one sell fill, so
   * this is FALSE on the very shape the question is about: the pieces are spread
   * ACROSS the components, which is what splitting means. What this one catches
   * is the opposite and reassuring case — the group that merged correctly, where
   * one component holds several fills on both sides.
   */
  bothSidesInPieces: boolean;
}

/** What the netPos walk found over one group's fills. */
interface WalkReport {
  /** Logical positions under REF-117's definition: flat → open → flat. */
  cycles: number;
  /** Sign changes that never landed on zero — a position flip (Q5, §A4). */
  zeroCrossings: number;
  /** A cycle still open at the end of the group's fills. */
  openTail: boolean;
  /** The running netPos returned to zero. A quantity decides it; none is emitted. */
  endsFlat: boolean;
  /** Fills the walk could not order, because the row stated no usable instant. */
  undatedFills: number;
}

/** One `(account, contract, trading day)`, as the response carries it. */
interface GroupReport {
  /** 0 is the most recent trading day in the response. Never a date — see the header. */
  dayIndex: number;
  fills: number;
  pairs: number;
  buyFills: number;
  sellFills: number;
  /**
   * THE ANSWER TO Q2, AND IT HAS TO BE AT THIS LEVEL.
   *
   * Both legs of the logical position filled in pieces. In case א that is
   * `buyFills: 2, sellFills: 2` over a group whose components are two 1+1s — so
   * asking the same question of a COMPONENT answers `false` on exactly the shape
   * being measured. Read beside `splits`: the two true together is the §1.4
   * hypothesis confirmed.
   */
  bothSidesInPieces: boolean;
  /** Fills with no pair at all: the open tail, or a leg the response did not carry. */
  unpairedFills: number;
  /** What `groupIntoTrades` produces today. */
  components: number;
  /** What REF-117's definition produces. */
  cycles: number;
  zeroCrossings: number;
  openTail: boolean;
  endsFlat: boolean;
  undatedFills: number;
  /**
   * Whether the walk agrees with `position.netPos` for this same day (§2.4).
   *
   * The invariant the whole of REF-117's design rests on. `null` means there was
   * no position row for this `(account, contract, day)` to compare against.
   */
  reconcilesWithNetPos: boolean | null;
  /** THE BUG, PER GROUP: today's grouping split one logical position. */
  splits: boolean;
  perComponent: ComponentReport[];
  /** True when `perComponent` was cut to {@link MAX_COMPONENTS}. */
  componentsCapped: boolean;
}

export interface FillsHostReport {
  endpoints: Record<string, unknown>;
  answers: Record<string, unknown>;
}

/** The netPos walk. Reads quantities; returns counts. See {@link WalkReport}. */
function walk(fills: readonly FillFacts[]): WalkReport {
  const dated = [...fills].sort(
    (a, b) => (a.atMs ?? 0) - (b.atMs ?? 0) || a.id - b.id
  );

  let net = 0;
  let cycles = 0;
  let zeroCrossings = 0;
  let open = false;

  for (const fill of dated) {
    const before = net;
    net += fill.buy ? fill.qty : -fill.qty;

    if (before === 0 && net !== 0) open = true;

    // A sign change that skipped zero: the trader reversed in one fill. The old
    // cycle ended inside it and a new one started, which is why this counts BOTH
    // a crossing and a completed cycle.
    if (before !== 0 && net !== 0 && Math.sign(before) !== Math.sign(net)) {
      zeroCrossings += 1;
      cycles += 1;
      open = true;
    }

    if (net === 0 && open) {
      cycles += 1;
      open = false;
    }
  }

  return {
    cycles,
    zeroCrossings,
    openTail: open,
    endsFlat: net === 0,
    undatedFills: fills.filter((fill) => fill.atMs === null).length,
  };
}

/** One component's counts, off the fills it touches. */
function describeComponent(members: readonly number[], byId: Map<number, FillFacts>): ComponentReport {
  const ids = [...new Set(members)];
  const facts = ids.map((id) => byId.get(id)).filter((f): f is FillFacts => f !== undefined);
  const buyFills = facts.filter((f) => f.buy).length;
  const sellFills = facts.length - buyFills;
  return {
    // Each edge pushed two members, so the edge count is half the pushes.
    pairs: members.length / 2,
    fills: ids.length,
    buyFills,
    sellFills,
    // `0` is what an absent numeric field coerces to and is not an id this API
    // issues — the same boundary `usableId` puts on every number read off the
    // wire (lib/tradovate/fills.ts).
    orders: new Set(facts.filter((f) => f.orderId > 0).map((f) => f.orderId)).size,
    bothSidesInPieces: buyFills > 1 && sellFills > 1,
  };
}

export async function probeFillsHost(options: {
  accessToken: string;
  apiUrl: string;
}): Promise<FillsHostReport> {
  const endpoints: Record<string, unknown> = {};
  const answers: Record<string, unknown> = {};

  // ── /position/list — the ONLY link from a fill to an account ──────────────
  //
  // `TradovateFill` carries no `accountId` and no `positionId` (types.ts), so
  // the chain is fill → pair.positionId → position.accountId. That is the
  // constraint REF-117 §2.2 turns on, and this probe is subject to it exactly as
  // the product is.
  const positions = await callEndpoint('/position/list', options);
  endpoints['/position/list'] = {
    ...reportOf(positions),
    fields: positions.ok ? fieldSurvey(positions.rows) : null,
  };

  const positionById = new Map<number, { accountId: number; contractId: number; netPos: number | null; dayKey: string | null }>();
  for (const row of positions.rows) {
    const id = int(row['id']);
    const accountId = int(row['accountId']);
    const contractId = int(row['contractId']);
    if (id === null || accountId === null || contractId === null) continue;
    positionById.set(id, { accountId, contractId, netPos: int(row['netPos']), dayKey: dayKeyOf(row) });
  }

  // ── /fillPair/list — the edges ────────────────────────────────────────────
  const pairs = await callEndpoint('/fillPair/list', options);
  endpoints['/fillPair/list'] = {
    ...reportOf(pairs),
    fields: pairs.ok ? fieldSurvey(pairs.rows) : null,
    truncationSuspected: pairs.count === null ? null : looksTruncated(pairs.count),
  };

  // ── /fill/list — the nodes ────────────────────────────────────────────────
  const fills = await callEndpoint('/fill/list', options);
  endpoints['/fill/list'] = {
    ...reportOf(fills),
    fields: fills.ok ? fieldSurvey(fills.rows) : null,
    truncationSuspected: fills.count === null ? null : looksTruncated(fills.count),
  };

  // Q3. Over the UNFILTERED response, before MAX_DAYS narrows anything — a
  // depth measured inside a window measures the window. Fractional, and
  // therefore deliberately not inside a strict subtree.
  answers['Q3'] = {
    question: 'עד כמה אחורה מגיע /fill/list?',
    fillDepthDays: fills.ok ? depthDays(fills.rows) : null,
    pairDepthDays: pairs.ok ? depthDays(pairs.rows) : null,
    distinctTradeDates: new Set(
      fills.rows.map(dayKeyOf).filter((key): key is string => key !== null)
    ).size,
    note: '/order/list נמדד כ-0 ב-19.10. אם גם כאן אין עומק — §2.4 מחזיקה כל עסקת סווינג.',
  };

  // ── THE NARROWING WALK (Q7) ───────────────────────────────────────────────
  //
  // Run UNCONDITIONALLY and not only when the lists came back thin, because the
  // comparison IS the measurement: "deps found 9 pairs where the list found 9"
  // is as much of an answer as "where the list found 0", and a conditional read
  // would make the two runs incomparable.
  const positionIds = [...positionById.keys()].slice(0, MAX_DEPS_POSITIONS);
  const depsPairRows: Row[] = [];
  const depsCalls: unknown[] = [];

  for (const masterid of positionIds) {
    const deps = await callEndpoint('/fillPair/deps', { ...options, query: { masterid } });
    depsCalls.push(reportOf(deps));
    depsPairRows.push(...deps.rows);
  }

  endpoints['/fillPair/deps'] = {
    positionsAsked: positionIds.length,
    positionsAvailable: positionById.size,
    capped: positionById.size > MAX_DEPS_POSITIONS,
    calls: depsCalls,
    rowCount: depsPairRows.length,
    fields: depsPairRows.length ? fieldSurvey(depsPairRows) : null,
  };

  // The fills those pairs name, asked for by id — the one read in this file that
  // can reach a fill `/fill/list` has dropped. Chunked; see ITEMS_CHUNK.
  const wantedFillIds = [
    ...new Set(
      depsPairRows.flatMap((row) => [int(row['buyFillId']), int(row['sellFillId'])])
        .filter((id): id is number => id !== null)
    ),
  ];

  const itemsFillRows: Row[] = [];
  const itemsCalls: unknown[] = [];
  for (let i = 0; i < wantedFillIds.length; i += ITEMS_CHUNK) {
    const ids = wantedFillIds.slice(i, i + ITEMS_CHUNK).join(',');
    const items = await callEndpoint('/fill/items', { ...options, query: { ids } });
    itemsCalls.push(reportOf(items));
    itemsFillRows.push(...items.rows);
  }

  endpoints['/fill/items'] = {
    idsAsked: wantedFillIds.length,
    calls: itemsCalls,
    rowCount: itemsFillRows.length,
    fields: itemsFillRows.length ? fieldSurvey(itemsFillRows) : null,
  };

  // Q4. Presence and non-null count, never a value — the shape ./live.ts uses
  // for every field question it asks. Over BOTH fill sources, so an answer
  // survives a day when the list is empty.
  const allFillRows = [...fills.rows, ...itemsFillRows];
  answers['Q4'] = {
    question: 'האם finallyPaired קיים ואמיתי?',
    present: hasField(allFillRows, 'finallyPaired'),
    nonNull: nonNullCount(allFillRows, 'finallyPaired'),
    trueCount: allFillRows.filter((row) => row['finallyPaired'] === true).length,
    falseCount: allFillRows.filter((row) => row['finallyPaired'] === false).length,
  };

  if (!positions.ok) {
    answers['Q1'] = {
      question: 'האם פוזיציה לוגית אחת מתפרקת לכמה עסקאות?',
      answered: 'לא — /position/list לא נענה על המארח הזה, ובלעדיו אין שיוך לחשבון. ראה endpoints.',
    };
    return { endpoints, answers };
  }

  // ── The graph, over BOTH reads ────────────────────────────────────────────
  //
  // One graph from whatever was found, which is what makes the narrowing walk
  // worth making: if the lists are empty and deps is not, the analysis below
  // runs on 19.10 instead of on nothing.

  const fillById = new Map<number, FillFacts>();
  /** Which read found each fill. Counted at the top of the response as `readVia`. */
  const fillSource = new Map<number, 'list' | 'items' | 'both'>();

  for (const row of fills.rows) {
    const facts = fillFactsOf(row);
    if (facts) {
      fillById.set(facts.id, facts);
      fillSource.set(facts.id, 'list');
    }
  }
  for (const row of itemsFillRows) {
    const facts = fillFactsOf(row);
    if (!facts) continue;
    fillSource.set(facts.id, fillById.has(facts.id) ? 'both' : 'items');
    // The list's copy wins where both answered: it is the shape the product
    // actually reads, so a difference between the two is worth not hiding
    // behind an overwrite.
    if (!fillById.has(facts.id)) fillById.set(facts.id, facts);
  }

  /** `fillId → accountId`, resolved through the pairs. See the note above. */
  const accountByFill = new Map<number, number>();
  let accountConflicts = 0;
  const edges: Edge[] = [];

  // Both pair reads, deduplicated BY PAIR ID. A pair that `/fillPair/list` and
  // `/fillPair/deps` both returned must contribute ONE edge — counting it twice
  // would inflate `pairs` and could weld two components that are genuinely one.
  const seenPairIds = new Set<number>();
  let pairsFromListUsed = 0;
  let pairsFromDepsOnly = 0;

  for (const [source, rows] of [['list', pairs.rows], ['deps', depsPairRows]] as const) {
    for (const row of rows) {
      const pairId = int(row['id']);
      const positionId = int(row['positionId']);
      const buyFillId = int(row['buyFillId']);
      const sellFillId = int(row['sellFillId']);
      if (positionId === null || buyFillId === null || sellFillId === null) continue;
      if (pairId !== null && seenPairIds.has(pairId)) continue;
      if (pairId !== null) seenPairIds.add(pairId);

      const position = positionById.get(positionId);
      if (!position) continue;

      if (source === 'list') pairsFromListUsed += 1;
      else pairsFromDepsOnly += 1;

      edges.push({ buyFillId, sellFillId, accountId: position.accountId, contractId: position.contractId });

      for (const fillId of [buyFillId, sellFillId]) {
        const seen = accountByFill.get(fillId);
        // One fill in two accounts is impossible and would mean the join is
        // wrong. Counted rather than thrown: a diagnostic that refuses to answer
        // tells the owner less than one that answers and says so.
        if (seen !== undefined && seen !== position.accountId) accountConflicts += 1;
        else accountByFill.set(fillId, position.accountId);
      }
    }
  }

  // The trading days present, newest first, so `dayIndex` is a relative offset
  // and no date is emitted. See the header.
  //
  // BUILT FROM THE FILLS **AND** THE POSITIONS, which matters on exactly the day
  // that produced this change: when `/fill/list` is empty and `/position/list`
  // is not, the positions are the only thing that establishes what "the most
  // recent trading day" is, and without them every index would shift.
  const dayOrder = [...new Set([
    ...[...fillById.values()].map((f) => f.dayKey),
    ...[...positionById.values()].map((p) => p.dayKey),
  ].filter((key): key is string => key !== null))].sort().reverse().slice(0, MAX_DAYS);
  const dayIndexOf = new Map(dayOrder.map((key, index) => [key, index]));

  /** `account|contract|day` → the fills and edges that belong to it. */
  const groups = new Map<string, { fills: FillFacts[]; edges: Edge[]; accountId: number; contractId: number; dayKey: string }>();
  const keyOf = (accountId: number, contractId: number, dayKey: string) =>
    `${accountId}|${contractId}|${dayKey}`;

  const bucket = (accountId: number, contractId: number, dayKey: string) => {
    const key = keyOf(accountId, contractId, dayKey);
    const found = groups.get(key);
    if (found) return found;
    const made = { fills: [] as FillFacts[], edges: [] as Edge[], accountId, contractId, dayKey };
    groups.set(key, made);
    return made;
  };

  // A fill whose account resolved through a pair. The contract and the day come
  // off the FILL — a fill cannot be in two contracts — and the account off the
  // join, which is the only place it exists.
  let unattributedFills = 0;
  for (const fill of fillById.values()) {
    if (fill.dayKey === null || !dayIndexOf.has(fill.dayKey)) continue;
    const accountId = accountByFill.get(fill.id);
    if (accountId === undefined) {
      // No pair names it yet: the open tail of a position, or a leg the
      // response did not carry. Counted as an aggregate rather than guessed
      // into a group — attributing it by `(contract, day)` alone is unsafe for
      // a trader holding one contract on two accounts (REF-110), and the
      // reconciliation below is what would have caught the mistake anyway.
      unattributedFills += 1;
      continue;
    }
    bucket(accountId, fill.contractId, fill.dayKey).fills.push(fill);
  }

  for (const edge of edges) {
    const buy = fillById.get(edge.buyFillId);
    const dayKey = buy?.dayKey ?? fillById.get(edge.sellFillId)?.dayKey ?? null;
    if (dayKey === null || !dayIndexOf.has(dayKey)) continue;
    bucket(edge.accountId, edge.contractId, dayKey).edges.push(edge);
  }

  /** `account|contract|day` → that day's `position.netPos`, for §2.4. */
  const netPosByGroup = new Map<string, number>();
  for (const position of positionById.values()) {
    if (position.dayKey === null || position.netPos === null) continue;
    netPosByGroup.set(keyOf(position.accountId, position.contractId, position.dayKey), position.netPos);
  }

  const perGroup: GroupReport[] = [];
  let totalComponents = 0;
  let totalCycles = 0;
  let splitGroups = 0;
  let bothSidesInPiecesComponents = 0;
  let bothSidesInPiecesGroups = 0;
  let splitWithBothSidesInPieces = 0;
  let totalZeroCrossings = 0;

  for (const [key, group] of groups) {
    const components = componentsOf(group.edges);
    const walked = walk(group.fills);
    const paired = new Set(group.edges.flatMap((edge) => [edge.buyFillId, edge.sellFillId]));

    const described = [...components.values()].map((members) => describeComponent(members, fillById));
    bothSidesInPiecesComponents += described.filter((c) => c.bothSidesInPieces).length;

    const expected = netPosByGroup.get(key);
    const netOfWalk = group.fills.reduce((total, fill) => total + (fill.buy ? fill.qty : -fill.qty), 0);

    const buyFills = group.fills.filter((fill) => fill.buy).length;
    const sellFills = group.fills.length - buyFills;
    const bothSidesInPieces = buyFills > 1 && sellFills > 1;
    if (bothSidesInPieces) bothSidesInPiecesGroups += 1;

    const splits = components.size > walked.cycles && walked.cycles > 0;
    if (splits) splitGroups += 1;
    if (splits && bothSidesInPieces) splitWithBothSidesInPieces += 1;
    totalComponents += components.size;
    totalCycles += walked.cycles;
    totalZeroCrossings += walked.zeroCrossings;

    perGroup.push({
      dayIndex: dayIndexOf.get(group.dayKey) ?? 0,
      fills: group.fills.length,
      pairs: group.edges.length,
      buyFills,
      sellFills,
      bothSidesInPieces,
      unpairedFills: group.fills.filter((fill) => !paired.has(fill.id)).length,
      components: components.size,
      cycles: walked.cycles,
      zeroCrossings: walked.zeroCrossings,
      openTail: walked.openTail,
      endsFlat: walked.endsFlat,
      undatedFills: walked.undatedFills,
      reconcilesWithNetPos: expected === undefined ? null : netOfWalk === expected,
      splits,
      perComponent: described.slice(0, MAX_COMPONENTS),
      componentsCapped: described.length > MAX_COMPONENTS,
    });
  }

  // Newest day first, and the groups that SPLIT first within a day: the owner is
  // reading this to find case א, so it should be at the top.
  perGroup.sort(
    (a, b) => a.dayIndex - b.dayIndex || Number(b.splits) - Number(a.splits) || b.pairs - a.pairs
  );

  // Q6. Does the one read that DID answer carry past trading days? If it does
  // not, there is no handle on yesterday at all and every import has to happen
  // inside the session — which is a product decision, not a probe finding, and
  // this is the measurement it would rest on.
  const positionsPerDay = dayOrder.map((dayKey, dayIndex) => {
    const rows = [...positionById.values()].filter((p) => p.dayKey === dayKey);
    return {
      dayIndex,
      positions: rows.length,
      flat: rows.filter((p) => p.netPos === 0).length,
      nonFlat: rows.filter((p) => p.netPos !== null && p.netPos !== 0).length,
    };
  });

  answers['Q6'] = {
    question: 'האם /position/list מגיע לימי מסחר קודמים?',
    positionRows: positionById.size,
    distinctTradeDates: new Set(
      [...positionById.values()].map((p) => p.dayKey).filter((key): key is string => key !== null)
    ).size,
    datelessRows: [...positionById.values()].filter((p) => p.dayKey === null).length,
    perDay: positionsPerDay,
    verdict:
      positionsPerDay.filter((d) => d.positions > 0).length > 1
        ? 'כן — יש שורות פוזיציה ליותר מיום מסחר אחד. יש ידית לאתמול; ראה Q7 אם היא מובילה למילויים.'
        : 'לא — שורות הפוזיציה הן של יום מסחר אחד בלבד. אם גם Q7 ריק, אין שום דרך להגיע לאתמול.',
  };

  // Q7. The comparison that is the whole point of the second read.
  const fillsFromItemsOnly = [...fillSource.values()].filter((via) => via === 'items').length;
  answers['Q7'] = {
    question: 'האם המסלול המצומצם מגיע למה ש-/fill/list לא?',
    pairsFromList: pairs.count,
    pairsFromDeps: depsPairRows.length,
    pairsFromDepsOnly,
    pairsFromListUsed,
    fillsFromList: fills.count,
    fillsFromItems: itemsFillRows.length,
    fillsFromItemsOnly,
    // The two that decide it: a read that found something the list did not.
    depsReachesMore: pairsFromDepsOnly > 0,
    itemsReachesMore: fillsFromItemsOnly > 0,
    verdict:
      pairsFromDepsOnly > 0 || fillsFromItemsOnly > 0
        ? 'כן — deps/items החזירו מה שהרשימות לא. יש מסלול לאתמול, והייבוא יכול להיבנות עליו.'
        : (pairs.count ?? 0) === 0 && (fills.count ?? 0) === 0 && positionById.size > 0
          ? 'לא — גם deps/items ריקים כשהרשימות ריקות. אין שום מסלול לאתמול; הייבוא חייב לקרות בתוך המסחר.'
          : 'deps/items לא מצאו שום דבר חדש, אבל הרשימות לא היו ריקות — כלומר אין מה להשוות עדיין.',
  };

  answers['Q1'] = {
    question: 'האם פוזיציה לוגית אחת מתפרקת היום לכמה עסקאות?',
    // Which read produced the graph this answer is computed over. On a day when
    // the lists are empty, `items` being non-zero is what makes Q1 meaningful
    // at all — and `list: 0, items: 0` is what makes it unanswerable.
    readVia: {
      fillsFromList: [...fillSource.values()].filter((via) => via === 'list').length,
      fillsFromBoth: [...fillSource.values()].filter((via) => via === 'both').length,
      fillsFromItemsOnly,
    },
    groups: groups.size,
    groupsReported: Math.min(groups.size, MAX_GROUPS),
    totalComponents,
    totalCycles,
    splitGroups,
    unattributedFills,
    accountConflicts,
    // THE VERDICT HANGS ON `splitGroups` AND NOT ON THE TOTALS, and that is not
    // a preference — the totals can CANCEL. A group that splits contributes
    // `components > cycles` and a group that flipped contributes
    // `cycles > components`, so one of each makes `totalComponents ===
    // totalCycles` while a real split is sitting in the list. Measured on the
    // fixtures this was driven against before it shipped.
    verdict:
      // THE CASE THE FIRST RUN LANDED IN, and it must not read as "no bug
      // found". No fill was reached by either read, so this question was not
      // answered — which is a different statement from answering it "no".
      groups.size === 0
        ? 'לא ניתן לענות — לא נמצא אף מילוי בשום קריאה. ראה Q3, Q6 ו-Q7, לא את השדות כאן.'
        : splitGroups > 0
          ? 'כן — יש קבוצה שבה components > cycles. זה מקרה א, נמדד. REF-117 מאומת.'
          : totalComponents === totalCycles
            ? 'לא בחלון הזה — components = cycles בכל קבוצה. לבדוק את העומק ב-Q3 לפני מסקנה.'
            : 'cycles גדול מ-components — הילוך ה-netPos מצא מחזורים שאין להם זוגות. לקרוא Q5.',
    perGroup: perGroup.slice(0, MAX_GROUPS),
  };

  answers['Q2'] = {
    question: 'האם גם הכניסה וגם היציאה התמלאו במנות?',
    // The one that answers the question: a GROUP with pieces on both sides.
    bothSidesInPiecesGroups,
    // The conjunction, which is the whole of §1.4: a logical position that both
    // filled in pieces on both sides AND got split by today's grouping.
    splitWithBothSidesInPieces,
    // Components that merged several fills on both sides — the reassuring case,
    // and the proof that the union-find does work when a fill is shared.
    bothSidesInPiecesComponents,
    verdict:
      splitWithBothSidesInPieces > 0
        ? 'כן — יש פוזיציה לוגית שהתמלאה במנות בשני הצדדים וגם פוצלה. ההשערה של §1.4 מאומתת.'
        : bothSidesInPiecesGroups > 0
          ? 'יש מנות בשני הצדדים אבל בלי פיצול — כלומר Tradovate זיווג דרך fill משותף והאיחוד עבד.'
          : 'לא נמצאה קבוצה עם מנות בשני הצדדים. אם splitGroups>0 בכל זאת — המנגנון אחר ממה שהדוח הניח.',
  };

  answers['Q5'] = {
    question: 'האם יש חציית אפס (היפוך), ומחזור שנפתח בלי להיסגר?',
    totalZeroCrossings,
    openTailGroups: perGroup.filter((g) => g.openTail).length,
    unreconciledGroups: perGroup.filter((g) => g.reconcilesWithNetPos === false).length,
    reconciliationUnavailable: perGroup.filter((g) => g.reconcilesWithNetPos === null).length,
    verdict:
      totalZeroCrossings > 0
        ? 'יש היפוך — Tradovate מדווח אותו כמילוי אחד, ולכן הפיצול הסינתטי של §3 נחוץ.'
        : 'לא נצפה היפוך בחלון. שאלת REF-107 §A4 נשארת פתוחה.',
  };

  return { endpoints, answers };
}
