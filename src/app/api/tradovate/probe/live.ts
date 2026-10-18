/**
 * `?mode=live` — REF-108 Q8/Q9 and REF-110's account-naming question.
 *
 * The same three questions `--live` asks in the spike, asked the same way. Its
 * header's warning carries over and is the first thing to check if this answers
 * nothing: **run it with a position open.** Every question here is about an
 * open position, and a flat account answers none of them.
 */

import { callEndpoint, reportOf, type CallResult } from './call';
import {
  enumValues,
  fieldSurvey,
  hasField,
  nonNullCount,
  type Row,
} from './survey';

/** Q8, Q9 and REF-110, as the owner reads them at the top of the response. */
export const LIVE_QUESTIONS = [
  'Q8  האם שדה כלשהו ב-cashBalance נושא רווח/הפסד פתוח (unrealised)?',
  '      אם כן — REF-108 שלב 4 לא צריך mark price (ואין לנו הרשאה אליו).',
  '      אם לא — הרצפה נשלחת כ-v1 והמספר החי יורד מחוסמי ההשקה.',
  'Q9  האם /position/list נושא מחיר כניסה ממוצע בכלל?',
  '      netPrice / avgPrice / bought / sold לא מופיעים בשום מקום ברפוזיטורי.',
  'REF-110  האם /account/list נושא nickname ו-archived?',
  '      account-sync.ts קורא `archived` הגנתית בלי להצהיר עליו; זה מה שמכריע.',
];

/**
 * A field name that might be carrying a profit-and-loss figure.
 *
 * NAMES ONLY — this never looks at a value, which is what keeps the verdict
 * printable. Deliberately WIDE, in the spike's words: a false positive costs
 * one line in a report the owner reads once, and a false negative costs the
 * whole feature, because a field this misses is a field nobody looks at again.
 *
 * `pl` is matched at a word-ish boundary rather than as a substring, or it
 * would flag `plugin`, `displayName` and `template`.
 */
const PNL_SHAPED =
  /(pnl|p_?and_?l|unrealiz|unrealis|realiz|realis|open|^pl$|^pl[A-Z_]|[_.]pl$|[_.]pl[A-Z_])/i;

/** Which of a survey's field names look like a P&L figure. */
function pnlShapedFields(fieldNames: string[]): string[] {
  return fieldNames.filter((name) => PNL_SHAPED.test(name.split('.').pop() ?? name)).sort();
}

/** Names Q9 asks about. Presence is reported per name; values never are. */
const POSITION_PRICE_FIELDS = [
  'netPrice',
  'avgPrice',
  'bought',
  'boughtValue',
  'sold',
  'soldValue',
  'prevPos',
  'prevPrice',
];

/** Names REF-110 asks about — the trader-set label and the closed-account flag. */
const ACCOUNT_NAMING_FIELDS = ['nickname', 'archived', 'name', 'active', 'closed', 'legalStatus'];

/**
 * How many accounts get a cash-balance snapshot.
 *
 * The snapshot is one request per account and Tradovate's limits are
 * documented as variable by hour, minute AND second, escalating to `p-captcha`
 * — which a third-party application cannot clear, so the trader waits about an
 * hour and their day pull waits with them. A probe is a diagnostic, not a
 * reason to spend that budget: a handful of accounts answers Q8 as well as
 * forty would, because Q8 is about whether a FIELD exists.
 */
const MAX_SNAPSHOT_ACCOUNTS = 5;

export interface LiveHostReport {
  endpoints: Record<string, unknown>;
  answers: Record<string, unknown>;
}

export async function probeLiveHost(options: {
  accessToken: string;
  apiUrl: string;
}): Promise<LiveHostReport> {
  const endpoints: Record<string, unknown> = {};
  const answers: Record<string, unknown> = {};

  // ── /position/list — Q9 ──────────────────────────────────────────────────
  const positions = await callEndpoint('/position/list', options);
  const positionRows = positions.rows;
  endpoints['/position/list'] = {
    ...reportOf(positions),
    fields: positions.ok ? fieldSurvey(positionRows) : null,
  };

  if (positions.ok) {
    const open = positionRows.filter((r) => typeof r['netPos'] === 'number' && r['netPos'] !== 0).length;
    answers['Q9'] = {
      question: 'האם /position/list נושא מחיר כניסה ממוצע?',
      rowCount: positionRows.length,
      openPositions: open,
      // The yes/no per name the brief asks for, with no value attached.
      priceFieldsPresent: Object.fromEntries(
        POSITION_PRICE_FIELDS.map((f) => [
          f,
          { present: hasField(positionRows, f), nonNull: nonNullCount(positionRows, f) },
        ])
      ),
      answered:
        open > 0
          ? true
          : 'לא — אין פוזיציה פתוחה בדגימה הזו. יש להריץ מחדש עם פוזיציה פתוחה.',
    };
  }

  // ── /account/list — REF-110 ──────────────────────────────────────────────
  const accounts = await callEndpoint('/account/list', options);
  const accountRows = accounts.rows;
  endpoints['/account/list'] = {
    ...reportOf(accounts),
    fields: accounts.ok ? fieldSurvey(accountRows) : null,
  };

  if (accounts.ok) {
    answers['REF-110'] = {
      question: 'האם /account/list נושא nickname ו-archived?',
      rowCount: accountRows.length,
      namingFieldsPresent: Object.fromEntries(
        ACCOUNT_NAMING_FIELDS.map((f) => [
          f,
          { present: hasField(accountRows, f), nonNull: nonNullCount(accountRows, f) },
        ])
      ),
      // An enum, so its values are emitted — and `accountType` is in the
      // vocabulary precisely because it names no trade.
      accountTypeValues: enumValues(accountRows, 'accountType'),
      // The decision account-sync.ts' saysArchived() is waiting on.
      verdict: hasField(accountRows, 'archived')
        ? 'archived קיים — saysArchived() ב-account-sync.ts מבוסס על שדה אמיתי'
        : 'archived לא קיים בדגימה — לשקול למחוק את saysArchived() ואת ענף archived',
    };
  }

  // ── /cashBalance/getcashbalancesnapshot — Q8 ─────────────────────────────
  const accountIds = accountRows
    .map((r) => r['id'])
    .filter((id): id is number => typeof id === 'number')
    .slice(0, MAX_SNAPSHOT_ACCOUNTS);

  const snapshotRows: Row[] = [];
  const snapshotCalls: Omit<CallResult, 'rows'>[] = [];
  for (const accountId of accountIds) {
    const snapshot = await callEndpoint('/cashBalance/getcashbalancesnapshot', {
      ...options,
      body: { accountId },
    });
    snapshotCalls.push(reportOf(snapshot));
    snapshotRows.push(...snapshot.rows);
  }

  const snapshotFields = snapshotRows.length ? fieldSurvey(snapshotRows) : null;
  endpoints['/cashBalance/getcashbalancesnapshot'] = {
    // Per-call statuses, aggregated — the account ids that drove them are not
    // carried out, only how many there were.
    accountsAsked: accountIds.length,
    accountsAvailable: accountRows.length,
    capped: accountRows.length > MAX_SNAPSHOT_ACCOUNTS,
    calls: snapshotCalls,
    rowCount: snapshotRows.length,
    fields: snapshotFields,
  };

  if (snapshotFields) {
    const flagged = pnlShapedFields(Object.keys(snapshotFields));
    answers['Q8'] = {
      question: 'האם שדה כלשהו ב-cashBalance נושא רווח/הפסד פתוח?',
      flaggedFields: flagged,
      // Names and a boolean. The verdict is the owner's to make from the
      // names; the probe measures and does not decide.
      verdict:
        flagged.length > 0
          ? 'יש שדות בעלי שם שנראה כמו P&L — לקרוא את הרשימה ולהכריע אם אחד מהם unrealised'
          : 'אין שדה בעל שם שנראה כמו P&L — REF-108 נשאר בלי מספר חי',
    };
  }

  return { endpoints, answers };
}
