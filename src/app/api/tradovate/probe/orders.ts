/**
 * `?mode=orders` — REF-113 Q1-Q7.
 *
 * The seven questions `--orders` asks in the spike, asked against the same
 * entities. Two differences from that script, both deliberate:
 *
 *   - **Deps, not list.** The spike reads `/orderVersion/list` wholesale. This
 *     walks `/order/list` and then asks for each order's children by
 *     `masterid`. That is what the brief specifies, and it is also the shape
 *     the real integration would use — the versions of *this* order are what
 *     REF-113 needs, not every version the account has ever produced.
 *
 *   - **A 48-hour window**, which the spike has no equivalent of. It bounds
 *     both the fan-out below and the amount of the trader's history the probe
 *     touches at all. Q3 ("how far back does /order/list reach") is therefore
 *     answered about the *unfiltered* response, before the window is applied —
 *     otherwise the window would be measuring itself.
 */

import { callEndpoint, reportOf, type CallResult } from './call';
import {
  changedFields,
  depthDays,
  distinctCount,
  enumValues,
  fieldSurvey,
  hasField,
  looksTruncated,
  nonNullCount,
  relativeSeconds,
  rowTime,
  type Row,
} from './survey';

/** The seven questions, as the owner reads them at the top of the response. */
export const ORDER_QUESTIONS = [
  'Q1  האם stopPrice יושב על orderVersion או על order?',
  'Q2  האם שינוי מייצר גרסה חדשה על אותה פקודה, וגרירה בסולם מייצרת cancel+replace?',
  'Q3  האם פקודות מבוטלות עדיין מוחזרות, וכמה אחורה?',
  'Q4  איזה שדה קישור מאוכלס בברקט אמיתי — orderStrategyLink, ocoId או parentId?',
  'Q5  איך נראה טריילינג סטופ, והאם pegDifference גלוי?',
  'Q6  האם /command/list מפריד בין שינוי של סוחר לצעד טריילינג של השרת?',
  'Q7  האם ספירה כלשהי נוחתת על מספר עגול (נחתך, לא מוצה)?',
];

/** The window the brief specifies. */
export const WINDOW_HOURS = 48;

/**
 * How many masters get a deps call, per entity.
 *
 * Deps are one request per master, so an unbounded walk over a busy account's
 * 48 hours is a burst of hundreds — straight into the variable rate limits
 * whose penalty escalates to `p-captcha`, which a third-party application
 * cannot clear. The questions here are about whether FIELDS exist and how
 * versions relate, and ten orders answer that as well as two hundred.
 *
 * The cap is reported in the response (`capped: true`) so a reader never
 * mistakes "we stopped asking" for "there was nothing more".
 */
const MAX_DEPS_MASTERS = 10;

/** Rows whose own instant falls inside the window. */
function withinWindow(rows: Row[], cutoffMs: number): Row[] {
  return rows.filter((r) => {
    const t = rowTime(r);
    return t !== null && t >= cutoffMs;
  });
}

/** Ask one entity for the children of several masters, and pool the rows. */
async function depsFor(
  path: string,
  masterIds: number[],
  options: { accessToken: string; apiUrl: string }
): Promise<{ rows: Row[]; calls: Omit<CallResult, 'rows'>[]; capped: boolean; asked: number }> {
  const asked = masterIds.slice(0, MAX_DEPS_MASTERS);
  const rows: Row[] = [];
  const calls: Omit<CallResult, 'rows'>[] = [];

  for (const masterid of asked) {
    const result = await callEndpoint(path, { ...options, query: { masterid } });
    calls.push(reportOf(result));
    rows.push(...result.rows);
  }

  return { rows, calls, capped: masterIds.length > MAX_DEPS_MASTERS, asked: asked.length };
}

/** Versions grouped by their order, oldest first. `id` breaks a tie. */
function versionsByOrder(versions: Row[]): Map<number, Row[]> {
  const byOrder = new Map<number, Row[]>();
  for (const v of versions) {
    const key = v['orderId'];
    if (typeof key !== 'number') continue;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key)!.push(v);
  }
  for (const list of byOrder.values()) {
    list.sort(
      (x, y) =>
        (rowTime(x) ?? 0) - (rowTime(y) ?? 0) ||
        ((x['id'] as number) ?? 0) - ((y['id'] as number) ?? 0)
    );
  }
  return byOrder;
}

export interface OrderHostReport {
  endpoints: Record<string, unknown>;
  answers: Record<string, unknown>;
}

export async function probeOrdersHost(options: {
  accessToken: string;
  apiUrl: string;
}): Promise<OrderHostReport> {
  const endpoints: Record<string, unknown> = {};
  const answers: Record<string, unknown> = {};
  const cutoffMs = Date.now() - WINDOW_HOURS * 3_600_000;

  // ── /order/list ──────────────────────────────────────────────────────────
  const orderCall = await callEndpoint('/order/list', options);
  const allOrders = orderCall.rows;
  const orders = withinWindow(allOrders, cutoffMs);

  endpoints['/order/list'] = {
    ...reportOf(orderCall),
    // Q3 and Q7 are about the WHOLE response, before the window — see header.
    totalCount: orderCall.count,
    depthDays: orderCall.ok ? depthDays(allOrders) : null,
    looksTruncated: orderCall.ok ? looksTruncated(allOrders.length) : null,
    inWindowCount: orderCall.ok ? orders.length : null,
    fields: orderCall.ok ? fieldSurvey(orders) : null,
  };

  if (!orderCall.ok) {
    answers['note'] = 'לא התקבלו פקודות מהמארח הזה — שאר השאלות לא נמדדו.';
    return { endpoints, answers };
  }

  const orderIds = orders.map((o) => o['id']).filter((id): id is number => typeof id === 'number');

  // ── /orderVersion/deps ───────────────────────────────────────────────────
  const versionDeps = await depsFor('/orderVersion/deps', orderIds, options);
  const versions = versionDeps.rows;
  endpoints['/orderVersion/deps'] = {
    mastersAvailable: orderIds.length,
    mastersAsked: versionDeps.asked,
    capped: versionDeps.capped,
    calls: versionDeps.calls,
    rowCount: versions.length,
    fields: versions.length ? fieldSurvey(versions) : null,
  };

  // ── /orderStrategy/list (+ deps) ─────────────────────────────────────────
  const strategyCall = await callEndpoint('/orderStrategy/list', options);
  const strategies = strategyCall.ok ? withinWindow(strategyCall.rows, cutoffMs) : [];
  const strategyIds = strategies
    .map((s) => s['id'])
    .filter((id): id is number => typeof id === 'number');
  const linkDeps = await depsFor('/orderStrategyLink/deps', strategyIds, options);

  endpoints['/orderStrategy/list'] = {
    ...reportOf(strategyCall),
    inWindowCount: strategyCall.ok ? strategies.length : null,
    fields: strategies.length ? fieldSurvey(strategies) : null,
  };
  endpoints['/orderStrategyLink/deps'] = {
    mastersAvailable: strategyIds.length,
    mastersAsked: linkDeps.asked,
    capped: linkDeps.capped,
    calls: linkDeps.calls,
    rowCount: linkDeps.rows.length,
    fields: linkDeps.rows.length ? fieldSurvey(linkDeps.rows) : null,
  };

  // ── /command/list (+ /commandReport/deps) ────────────────────────────────
  const commandCall = await callEndpoint('/command/list', options);
  const commands = commandCall.ok ? withinWindow(commandCall.rows, cutoffMs) : [];
  const commandIds = commands
    .map((c) => c['id'])
    .filter((id): id is number => typeof id === 'number');
  const reportDeps = await depsFor('/commandReport/deps', commandIds, options);

  endpoints['/command/list'] = {
    ...reportOf(commandCall),
    inWindowCount: commandCall.ok ? commands.length : null,
    looksTruncated: commandCall.ok ? looksTruncated(commandCall.rows.length) : null,
    fields: commands.length ? fieldSurvey(commands) : null,
  };
  endpoints['/commandReport/deps'] = {
    mastersAvailable: commandIds.length,
    mastersAsked: reportDeps.asked,
    capped: reportDeps.capped,
    calls: reportDeps.calls,
    rowCount: reportDeps.rows.length,
    fields: reportDeps.rows.length ? fieldSurvey(reportDeps.rows) : null,
  };

  // ── /executionReport/deps ────────────────────────────────────────────────
  const execDeps = await depsFor('/executionReport/deps', orderIds, options);
  endpoints['/executionReport/deps'] = {
    mastersAvailable: orderIds.length,
    mastersAsked: execDeps.asked,
    capped: execDeps.capped,
    calls: execDeps.calls,
    rowCount: execDeps.rows.length,
    fields: execDeps.rows.length ? fieldSurvey(execDeps.rows) : null,
  };

  // ── Q1 — where the stop price lives ──────────────────────────────────────
  const orderHasStop = hasField(orders, 'stopPrice');
  const versionHasStop = hasField(versions, 'stopPrice');
  answers['Q1'] = {
    question: 'האם stopPrice יושב על orderVersion או על order?',
    stopPriceOnOrder: orderHasStop,
    stopPriceOnVersion: versionHasStop,
    versionRowsWithNonNullStop: nonNullCount(versions, 'stopPrice'),
    priceOnOrder: hasField(orders, 'price'),
    priceOnVersion: hasField(versions, 'price'),
    verdict:
      versionHasStop && !orderHasStop
        ? 'אושר: התנאים על הגרסה. היסטוריית הגרסאות היא היסטוריית ההזזות.'
        : orderHasStop && !versionHasStop
          ? 'הופרך: התנאים על הפקודה. REF-113 צריך מקור אחר — להסלים.'
          : versionHasStop && orderHasStop
            ? 'שניהם נושאים. להכריע מי הסמכות לפני שבונים.'
            : 'אף אחד לא נושא בדגימה הזו. להציב פקודת סטופ ידנית ולהריץ מחדש.',
  };

  // ── Q2 — versions per order, what changes, and WHEN ──────────────────────
  const byOrder = versionsByOrder(versions);
  const counts = [...byOrder.values()].map((l) => l.length);
  const changeTally = new Map<string, number>();
  for (const list of byOrder.values()) {
    const seenHere = new Set<string>();
    for (let i = 1; i < list.length; i++) {
      for (const f of changedFields(list[i - 1], list[i])) seenHere.add(f);
    }
    for (const f of seenHere) changeTally.set(f, (changeTally.get(f) ?? 0) + 1);
  }

  // The relative timeline the brief asks for, on the order that actually
  // carries a moving stop — "version 2 was created X seconds after the first".
  // Offsets only; see relativeSeconds() on why no instant is carried out.
  const stopOrders = [...byOrder.entries()].filter(([, list]) =>
    list.some((v) => v['stopPrice'] !== null && v['stopPrice'] !== undefined)
  );
  let timeline: unknown = null;
  if (stopOrders.length) {
    const [, newest] = stopOrders.sort(
      (a, b) => (rowTime(b[1][0]) ?? 0) - (rowTime(a[1][0]) ?? 0)
    )[0];
    const offsets = relativeSeconds(newest);
    const distinctStops = new Set(
      newest.map((v) => v['stopPrice']).filter((p) => p !== null && p !== undefined)
    ).size;
    timeline = {
      versionCount: newest.length,
      distinctStopPriceValues: distinctStops,
      stopMoved: distinctStops > 1,
      orderTypes: enumValues(newest, 'orderType'),
      // index 0 is the first version; each entry is seconds after it.
      secondsAfterFirstVersion: offsets,
      changesPerStep: newest.slice(1).map((_, i) => ({
        step: `v${i + 1} -> v${i + 2}`,
        secondsAfterFirstVersion: offsets[i + 1],
        changedFields: changedFields(newest[i], newest[i + 1]),
      })),
    };
  }

  answers['Q2'] = {
    question: 'האם שינוי מייצר גרסה חדשה על אותה פקודה?',
    distinctOrdersWithVersions: byOrder.size,
    maxVersionsOnOneOrder: counts.length ? Math.max(...counts) : 0,
    ordersWithNoVersion: orders.filter(
      (o) => typeof o['id'] === 'number' && !byOrder.has(o['id'] as number)
    ).length,
    fieldsChangingBetweenVersions: Object.fromEntries(
      [...changeTally.entries()].sort((a, b) => b[1] - a[1])
    ),
    stopPriceChangesAcrossVersions: changeTally.has('stopPrice'),
    mostRecentStopOrderTimeline: timeline,
  };

  // ── Q3 — cancelled orders, and depth ─────────────────────────────────────
  const ordStatuses = enumValues(orders, 'ordStatus');
  const terminal = ordStatuses.filter((s) => /cancel|reject|expire/i.test(s));
  answers['Q3'] = {
    question: 'האם פקודות מבוטלות עדיין מוחזרות, וכמה אחורה?',
    ordStatusValues: ordStatuses,
    terminalStatusesVisible: terminal.length > 0,
    terminalStatuses: terminal,
    // Measured on the unfiltered response — the window is 48h by construction.
    depthDaysUnfiltered: depthDays(allOrders),
  };

  // ── Q4 — linkage ─────────────────────────────────────────────────────────
  answers['Q4'] = {
    question: 'איזה שדה קישור מאוכלס בברקט אמיתי?',
    orderLinkageFields: Object.fromEntries(
      ['ocoId', 'parentId', 'linkedId', 'oso', 'orderStrategyId'].map((f) => [
        f,
        { present: hasField(orders, f), nonNull: nonNullCount(orders, f) },
      ])
    ),
    orderStrategyRows: strategies.length,
    orderStrategyLinkRows: linkDeps.rows.length,
    // A count, not the strings — a link label can be the trader's own name for
    // a strategy. See the note on VOCABULARY in ./survey.ts.
    linkLabelPresent: hasField(linkDeps.rows, 'label'),
    linkLabelDistinctValues: distinctCount(linkDeps.rows, 'label'),
  };

  // ── Q5 — trailing stops ──────────────────────────────────────────────────
  const orderTypes = [...new Set([...enumValues(versions, 'orderType'), ...enumValues(orders, 'orderType')])].sort();
  const trailing = orderTypes.filter((t) => /trail/i.test(t));
  answers['Q5'] = {
    question: 'איך נראה טריילינג סטופ, והאם pegDifference גלוי?',
    orderTypeValues: orderTypes,
    trailingOrderTypePresent: trailing.length > 0,
    trailingOrderTypes: trailing,
    pegDifferenceOnVersion: hasField(versions, 'pegDifference'),
    pegDifferenceNonNull: nonNullCount(versions, 'pegDifference'),
  };

  // ── Q6 — commands ────────────────────────────────────────────────────────
  const commandTypes = enumValues(commands, 'commandType');
  const modifyShaped = commandTypes.filter((t) => /modify|replace/i.test(t));
  answers['Q6'] = {
    question: 'האם /command/list מפריד בין שינוי של סוחר לצעד טריילינג של השרת?',
    commandTypeValues: commandTypes,
    commandStatusValues: enumValues(commands, 'commandStatus'),
    modifyShapedCommandTypePresent: modifyShaped.length > 0,
    modifyShapedCommandTypes: modifyShaped,
    commandReportEventTypes: enumValues(reportDeps.rows, 'eventType'),
  };

  // ── Q7 — truncation ──────────────────────────────────────────────────────
  answers['Q7'] = {
    question: 'האם ספירה כלשהי נוחתת על מספר עגול?',
    counts: {
      '/order/list': allOrders.length,
      '/orderStrategy/list': strategyCall.ok ? strategyCall.rows.length : null,
      '/command/list': commandCall.ok ? commandCall.rows.length : null,
    },
    truncated: {
      '/order/list': looksTruncated(allOrders.length),
      '/orderStrategy/list': strategyCall.ok ? looksTruncated(strategyCall.rows.length) : null,
      '/command/list': commandCall.ok ? looksTruncated(commandCall.rows.length) : null,
    },
  };

  return { endpoints, answers };
}
