// Demo-mode fixtures — the data behind /demo/*.
//
// Rows are shaped exactly like their DB tables (snake_case, full column set)
// so the real pages consume them untouched through the demo query stub.
// All dates are computed relative to "now" at request time, so the calendar
// and stats always look current without reseeding.

import { isWinningTrade, tradeMoneyPnl } from '@/lib/pnl';

// ── Demo user ─────────────────────────────────────────────────────────────────

export const DEMO_USER_ID = 'demo-user-00000000-0000-0000-0000-000000000000';

export const DEMO_USER = {
  id: DEMO_USER_ID,
  email: 'demo@reflect.app',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00.000Z',
};

// ── Date helpers ──────────────────────────────────────────────────────────────

/** ISO timestamp `daysAgo` days back at hour:min local time; never on Saturday. */
function iso(daysAgo: number, hour: number, min = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1); // shift Saturday → Friday
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

function dateOnly(isoStr: string): string {
  return isoStr.slice(0, 10);
}

// ── Trades ────────────────────────────────────────────────────────────────────

interface TradeSpec {
  d: number; h: number;               // days ago, entry hour
  sym: 'NQ' | 'ES';
  dir: 'long' | 'short';
  strat: 0 | 1;                       // index into DEMO_STRATEGIES
  entry: number; sl: number; tp: number;
  exit: number | null;                // null → still open
  emo: number; conf: number;
  score: number | null;
  reason: string;
  exitReason?: string;
  notes?: string;
  debrief?: string;
  fomo?: boolean; revenge?: boolean; movedSl?: boolean; followed?: boolean;
  setup?: string;
  u?: number;                         // units/quantity (default 1)
  durH?: number;                      // hours from entry to close (default 2)
}

const STRAT_NAMES = ['פריצת פתיחה', 'החזרה לממוצע'] as const;

// ~65% winners among closed, R:R 0.5–3, current + previous month.
const TRADE_SPECS: TradeSpec[] = [
  // ── Open positions ──
  { d: 0,  h: 16, sym: 'NQ', dir: 'long',  strat: 0, entry: 22240, sl: 22190, tp: 22350, exit: null, emo: 4, conf: 4, score: null,
    reason: 'פריצת טווח פתיחה עם ווליום גבוה מהממוצע', setup: 'demo-setup-orb' },
  { d: 1,  h: 17, sym: 'ES', dir: 'short', strat: 1, entry: 6285, sl: 6297, tp: 6255, exit: null, emo: 3, conf: 3, score: null,
    reason: 'דחייה מ-VWAP אחרי גאפ פתיחה למעלה' },

  // ── Current month ──
  { d: 2,  h: 16, sym: 'NQ', dir: 'long',  strat: 0, entry: 22150, sl: 22105, tp: 22245, exit: 22245, emo: 4, conf: 4, score: 88,
    reason: 'המשך מגמה מעל ממוצע 20 בדקות', exitReason: 'הגיע ליעד Take Profit',
    debrief: 'חיכיתי לאישור נר סגירה מעל הרמה — כניסה לפי התוכנית, בלי לרדוף.', setup: 'demo-setup-orb' },
  { d: 3,  h: 18, sym: 'ES', dir: 'long',  strat: 1, entry: 6250, sl: 6238, tp: 6280, exit: 6272, emo: 3, conf: 4, score: 81,
    reason: 'קנייה בבדיקה שנייה של תמיכה יומית', exitReason: 'יציאה ידנית — רווח',
    notes: 'סגרתי חלק לפני נאום הפד — העדפתי להקטין חשיפה לפני אירוע.' },
  { d: 3,  h: 20, sym: 'NQ', dir: 'short', strat: 0, entry: 22300, sl: 22350, tp: 22180, exit: 22350, emo: 2, conf: 2, score: 42,
    reason: 'ניסיון להחזיר הפסד מהעסקה הקודמת', exitReason: 'הגיע Stop Loss',
    notes: 'עסקת נקמה קלאסית — נכנסתי בלי סטאפ אמיתי. חוק ה-Loss Streak היה אמור לעצור אותי.',
    revenge: true, followed: false, durH: 1 },
  { d: 5,  h: 16, sym: 'ES', dir: 'long',  strat: 0, entry: 6260, sl: 6248, tp: 6296, exit: 6296, emo: 4, conf: 5, score: 92,
    reason: 'פריצת שיא שבועי עם רוחב שוק חיובי', exitReason: 'הגיע ליעד Take Profit',
    debrief: 'ביצוע נקי מהכניסה עד היציאה. הגודל היה נכון והיעד ריאלי.', setup: 'demo-setup-vwap', u: 2 },
  { d: 6,  h: 17, sym: 'NQ', dir: 'long',  strat: 0, entry: 22050, sl: 22000, tp: 22160, exit: 22135, emo: 4, conf: 4, score: 86,
    reason: 'דגל שורי אחרי מהלך מומנטום', exitReason: 'יציאה ידנית — רווח' },
  { d: 7,  h: 16, sym: 'NQ', dir: 'short', strat: 1, entry: 22180, sl: 22230, tp: 22080, exit: 22230, emo: 3, conf: 3, score: 58,
    reason: 'שבירת תמיכה תוך-יומית', exitReason: 'הגיע Stop Loss',
    notes: 'נכנסתי דקות לפני פרסום CPI — ספייק חדשותי חטף את הסטופ. לבדוק לוח אירועים לפני כל כניסה.' },
  { d: 8,  h: 18, sym: 'ES', dir: 'long',  strat: 1, entry: 6238, sl: 6226, tp: 6262, exit: 6262, emo: 4, conf: 4, score: 84,
    reason: 'החזרה לממוצע 20 בתוך טרנד עולה', exitReason: 'הגיע ליעד Take Profit', setup: 'demo-setup-vwap' },

  // ── Previous month ──
  { d: 10, h: 16, sym: 'NQ', dir: 'long',  strat: 0, entry: 21980, sl: 21940, tp: 22100, exit: 22100, emo: 5, conf: 5, score: 95,
    reason: 'פריצה נקייה של טווח הפתיחה', exitReason: 'הגיע ליעד Take Profit',
    debrief: 'העסקה הכי טובה של החודש — סבלנות עד לסטאפ המדויק.', setup: 'demo-setup-orb', u: 2 },
  { d: 11, h: 17, sym: 'ES', dir: 'short', strat: 1, entry: 6270, sl: 6282, tp: 6240, exit: 6246, emo: 4, conf: 4, score: 83,
    reason: 'מתיחה של 2 סטיות תקן מעל VWAP', exitReason: 'יציאה ידנית — רווח' },
  { d: 12, h: 19, sym: 'NQ', dir: 'long',  strat: 1, entry: 22120, sl: 22070, tp: 22195, exit: 22070, emo: 3, conf: 3, score: 55,
    reason: 'קנייה בירידה לממוצע — נגד מומנטום', exitReason: 'הגיע Stop Loss',
    debrief: 'הסטאפ היה בסדר אבל התזמון מוקדם מדי. לחכות לנר היפוך.' },
  { d: 13, h: 16, sym: 'ES', dir: 'long',  strat: 0, entry: 6215, sl: 6203, tp: 6245, exit: 6245, emo: 4, conf: 4, score: 87,
    reason: 'גאפ אנד גו מעל שיא אתמול', exitReason: 'הגיע ליעד Take Profit', setup: 'demo-setup-orb' },
  { d: 14, h: 18, sym: 'NQ', dir: 'short', strat: 0, entry: 22250, sl: 22300, tp: 22150, exit: 22165, emo: 4, conf: 4, score: 85,
    reason: 'כשל פריצה מעל שיא — מלכודת קונים', exitReason: 'יציאה ידנית — רווח', u: 2 },
  { d: 17, h: 16, sym: 'NQ', dir: 'long',  strat: 0, entry: 21900, sl: 21850, tp: 21975, exit: 21975, emo: 4, conf: 3, score: 79,
    reason: 'המשכיות אחרי איחוד צמוד בשיא', exitReason: 'הגיע ליעד Take Profit' },
  { d: 18, h: 17, sym: 'ES', dir: 'long',  strat: 1, entry: 6195, sl: 6183, tp: 6213, exit: 6183, emo: 2, conf: 4, score: 61,
    reason: 'החזרה לממוצע אחרי פתיחה אדומה', exitReason: 'הגיע Stop Loss',
    notes: 'ישנתי רע והתעקשתי לסחור. מצב רגשי 2 — היה צריך לדלג על היום.' },
  { d: 19, h: 20, sym: 'NQ', dir: 'long',  strat: 0, entry: 22010, sl: 21970, tp: 22130, exit: 22130, emo: 4, conf: 5, score: 90,
    reason: 'פריצת דגל בשעת הכוח האחרונה', exitReason: 'הגיע ליעד Take Profit', setup: 'demo-setup-orb' },
  { d: 20, h: 16, sym: 'ES', dir: 'short', strat: 1, entry: 6240, sl: 6250, tp: 6220, exit: 6234, emo: 3, conf: 3, score: 74,
    reason: 'דחייה כפולה מהתנגדות שבועית', exitReason: 'סגירה מוקדמת', durH: 1 },
  { d: 21, h: 17, sym: 'NQ', dir: 'short', strat: 0, entry: 22350, sl: 22400, tp: 22250, exit: 22400, emo: 3, conf: 4, score: 63,
    reason: 'שורט בשבירת תמיכת בוקר', exitReason: 'הגיע Stop Loss',
    movedSl: true, debrief: 'הזזתי את הסטופ פעם אחת לפני שנחטף. חוק קשיח: הסטופ לא זז.' },
  { d: 24, h: 16, sym: 'NQ', dir: 'long',  strat: 0, entry: 21820, sl: 21770, tp: 21930, exit: 21930, emo: 5, conf: 4, score: 91,
    reason: 'פריצת טווח פתיחה ביום מגמה', exitReason: 'הגיע ליעד Take Profit', u: 2, setup: 'demo-setup-orb' },
  { d: 25, h: 18, sym: 'ES', dir: 'long',  strat: 1, entry: 6170, sl: 6158, tp: 6188, exit: 6188, emo: 4, conf: 4, score: 82,
    reason: 'קנייה ב-Pullback לאזור הביקוש', exitReason: 'הגיע ליעד Take Profit', setup: 'demo-setup-vwap' },
  { d: 26, h: 16, sym: 'NQ', dir: 'long',  strat: 1, entry: 21880, sl: 21830, tp: 21955, exit: 21830, emo: 3, conf: 2, score: 48,
    reason: 'ראיתי את כולם נכנסים — פחדתי לפספס את המהלך', exitReason: 'הגיע Stop Loss',
    fomo: true, followed: false, notes: 'כניסת FOMO בלי אישור. הכלל של Reflect צדק — קיבלתי אזהרה ונכנסתי בכל זאת.' },
  { d: 27, h: 17, sym: 'ES', dir: 'short', strat: 0, entry: 6210, sl: 6220, tp: 6180, exit: 6186, emo: 4, conf: 4, score: 88,
    reason: 'שבירת רצפת איחוד אחרי חדשות', exitReason: 'יציאה ידנית — רווח' },
  { d: 28, h: 16, sym: 'NQ', dir: 'long',  strat: 0, entry: 21750, sl: 21700, tp: 21850, exit: 21850, emo: 4, conf: 4, score: 86,
    reason: 'המשך מגמה מעל ממוצע 20', exitReason: 'הגיע ליעד Take Profit' },
  { d: 31, h: 18, sym: 'ES', dir: 'long',  strat: 1, entry: 6150, sl: 6138, tp: 6174, exit: 6156, emo: 3, conf: 3, score: 72,
    reason: 'החזרה לממוצע בשוק דשדוש', exitReason: 'סגירה מוקדמת', durH: 1 },
  { d: 32, h: 16, sym: 'NQ', dir: 'short', strat: 1, entry: 21950, sl: 21990, tp: 21870, exit: 21990, emo: 3, conf: 3, score: 57,
    reason: 'מתיחה מעל VWAP — שורט נגד מגמה', exitReason: 'הגיע Stop Loss' },
  { d: 33, h: 17, sym: 'NQ', dir: 'long',  strat: 0, entry: 21680, sl: 21630, tp: 21790, exit: 21790, emo: 4, conf: 5, score: 89,
    reason: 'פריצת שיא יומי עם ווליום', exitReason: 'הגיע ליעד Take Profit', setup: 'demo-setup-orb' },
  { d: 34, h: 16, sym: 'ES', dir: 'long',  strat: 0, entry: 6120, sl: 6108, tp: 6150, exit: 6108, emo: 2, conf: 3, score: 52,
    reason: 'פריצה שנכשלה מיד אחרי הפתיחה', exitReason: 'הגיע Stop Loss', durH: 1 },
  { d: 36, h: 17, sym: 'ES', dir: 'short', strat: 1, entry: 6165, sl: 6177, tp: 6141, exit: 6147, emo: 4, conf: 4, score: 84,
    reason: 'דחייה מהתנגדות + סטיית RSI', exitReason: 'יציאה ידנית — רווח' },
  { d: 38, h: 16, sym: 'NQ', dir: 'long',  strat: 1, entry: 21600, sl: 21550, tp: 21675, exit: 21675, emo: 4, conf: 4, score: 83,
    reason: 'קנייה בבדיקת אזור ביקוש יומי', exitReason: 'הגיע ליעד Take Profit', setup: 'demo-setup-vwap' },
];

// ₪ per index point (micro-contract equivalent)
const PT_VALUE_ILS: Record<'NQ' | 'ES', number> = { NQ: 7, ES: 18 };

function buildTrade(spec: TradeSpec, i: number) {
  const submitted = iso(spec.d, spec.h);
  const closed = spec.exit != null ? iso(spec.d, spec.h + (spec.durH ?? 2)) : null;
  const points = spec.exit != null
    ? (spec.dir === 'long' ? spec.exit - spec.entry : spec.entry - spec.exit)
    : null;
  const units = spec.u ?? 1;
  const pnl = points != null ? Math.round(points * PT_VALUE_ILS[spec.sym] * units) : null;
  const rr = Math.round((Math.abs(spec.tp - spec.entry) / Math.abs(spec.entry - spec.sl)) * 10) / 10;
  const isClosed = spec.exit != null;

  return {
    id: `demo-trade-${String(i + 1).padStart(2, '0')}`,
    user_id: DEMO_USER_ID,
    strategy: STRAT_NAMES[spec.strat],
    symbol: spec.sym,
    entry_price: spec.entry,
    stop_loss: spec.sl,
    take_profit: spec.tp,
    rr_ratio: rr,
    trade_reason: spec.reason,
    emotional_state: spec.emo,
    confidence_level: spec.conf,
    timeframe: spec.strat === 0 ? '5m' : '15m',
    status: isClosed ? 'closed' : 'open',
    exit_price: spec.exit,
    exit_reason: spec.exitReason ?? null,
    post_trade_notes: spec.notes ?? null,
    plan_score: spec.score,
    debrief_answer: spec.debrief ?? null,
    debrief_submitted_at: spec.debrief ? closed : null,
    submitted_at: submitted,
    closed_at: closed,
    quantity: units,
    pnl_amount: pnl,
    pnl_currency: pnl != null ? '₪' : null,
    followed_plan: isClosed ? (spec.followed ?? true) : null,
    kept_sl: isClosed ? !(spec.movedSl ?? false) : null,
    proper_size: isClosed ? true : null,
    moved_sl: isClosed ? (spec.movedSl ?? false) : null,
    exited_early: isClosed ? spec.exitReason === 'סגירה מוקדמת' : null,
    fomo_entry: isClosed ? (spec.fomo ?? false) : null,
    revenge_trade: isClosed ? (spec.revenge ?? false) : null,
    direction: spec.dir,
    units,
    point_value: PT_VALUE_ILS[spec.sym],
    risk_amount: Math.round(Math.abs(spec.entry - spec.sl) * PT_VALUE_ILS[spec.sym] * units),
    risk_type: 'dollar',
    actual_pnl: pnl,
    strategy_conditions_checked: isClosed
      ? [
          { condition: 'כיוון המגמה תואם', checked: spec.followed ?? true },
          { condition: 'ווליום מעל ממוצע', checked: true },
          { condition: 'יחס סיכון-סיכוי תקין', checked: rr >= 1 },
        ]
      : null,
    setup_id: spec.setup ?? null,
  };
}

const DEMO_TRADES = TRADE_SPECS
  .map(buildTrade)
  .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));

// ── Other tables ──────────────────────────────────────────────────────────────

const DEMO_PROFILE = {
  id: DEMO_USER_ID,
  email: DEMO_USER.email,
  display_name: 'סוחר דמו',
  trading_type: ['day', 'futures'],
  experience_level: 'intermediate',
  default_market: ['futures'],
  custom_strategies: null,
  trader_identity: 'Disciplined Sniper',
  trader_type: null,
  onboarding_completed: true,
  subscription_tier: 'pro',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: iso(1, 12),
};

const DEMO_PRESET_RULES = {
  id: 'demo-preset-rules',
  user_id: DEMO_USER_ID,
  min_rr_ratio: 1.5,
  max_daily_trades: 4,
  cooldown_after_losses: 2,
  cooldown_minutes: 45,
  max_daily_loss: 1500,
  min_emotional_state: 3,
  allowed_strategies: ['Breakout', 'VWAP', 'Price Action'],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: iso(20, 12),
};

const DEMO_CUSTOM_RULES = [
  {
    id: 'demo-rule-1', user_id: DEMO_USER_ID, name: 'מקסימום 3 עסקאות ביום',
    is_active: true, condition_type: 'daily_trades_count', threshold_value: 3,
    action_type: 'block_day', cooldown_minutes: null, created_at: '2026-02-10T09:00:00.000Z',
  },
  {
    id: 'demo-rule-2', user_id: DEMO_USER_ID, name: 'עצירה אחרי 2 הפסדים רצופים',
    is_active: true, condition_type: 'loss_streak', threshold_value: 2,
    action_type: 'block_timer', cooldown_minutes: 60, created_at: '2026-03-02T09:00:00.000Z',
  },
  {
    id: 'demo-rule-3', user_id: DEMO_USER_ID, name: 'אזהרה אחרי כניסת FOMO',
    is_active: true, condition_type: 'fomo_last_trade', threshold_value: null,
    action_type: 'warn', cooldown_minutes: null, created_at: '2026-04-15T09:00:00.000Z',
  },
];

const DEMO_STRATEGIES = [
  {
    id: 'demo-strategy-1', user_id: DEMO_USER_ID, name: STRAT_NAMES[0],
    description: 'פריצת טווח הפתיחה של 30 הדקות הראשונות בכיוון המגמה, עם אישור ווליום.',
    direction: 'both', stop_loss_points: 50, take_profit_points: 100,
    risk_rules: 'סיכון קבוע של 1% לעסקה, מקסימום 2 עסקאות פתוחות במקביל.',
    preferred_hours: '16:30–18:30', markets: ['futures'], is_builtin: false,
    created_at: '2026-02-01T09:00:00.000Z', min_rr: 1.5,
    trading_hours_start: '16:30', trading_hours_end: '18:30',
    allowed_timeframes: ['5m', '15m'],
    entry_conditions: ['פריצה מעל/מתחת לטווח הפתיחה', 'ווליום מעל הממוצע', 'כיוון תואם מגמה יומית'],
    max_daily_trades: 3,
  },
  {
    id: 'demo-strategy-2', user_id: DEMO_USER_ID, name: STRAT_NAMES[1],
    description: 'כניסה בחזרה לממוצע נע 20 בתוך מגמה קיימת, אחרי מתיחה קיצונית.',
    direction: 'both', stop_loss_points: 40, take_profit_points: 60,
    risk_rules: 'אין כניסה נגד המגמה היומית. סיכון עד 0.5% בעסקאות נגד מומנטום.',
    preferred_hours: '17:00–20:00', markets: ['futures'], is_builtin: false,
    created_at: '2026-03-01T09:00:00.000Z', min_rr: 1,
    trading_hours_start: '17:00', trading_hours_end: '20:00',
    allowed_timeframes: ['15m'],
    entry_conditions: ['מרחק של 2 סטיות תקן מהממוצע', 'נר היפוך ברור', 'אין חדשות בעשר הדקות הקרובות'],
    max_daily_trades: 2,
  },
];

const DEMO_NOTEBOOK_PAGES = [
  {
    id: 'demo-note-1', user_id: DEMO_USER_ID,
    title: 'סיכום שבוע — משמעת מעל הכל',
    content: 'שבוע חזק: 4 מתוך 5 עסקאות לפי התוכנית.\n\nמה עבד: חיכיתי לאישור ווליום בכל פריצה, והיציאות היו לפי היעד המקורי.\n\nמה פחות: עסקת הנקמה של יום שלישי. ההפסד עצמו קטן, אבל הדפוס מסוכן — Reflect חסם אותי נכון ביום רביעי בבוקר.\n\nפוקוס לשבוע הבא: אפס עסקאות אחרי 2 הפסדים רצופים. בלי יוצאים מן הכלל.',
    page_type: 'journal', tags: ['פסיכולוגיה', 'חשוב'],
    created_at: iso(4, 21), updated_at: iso(2, 8),
  },
  {
    id: 'demo-note-2', user_id: DEMO_USER_ID,
    title: 'יום CPI — לקח יקר',
    content: 'נכנסתי לשורט ב-NQ שלוש דקות לפני פרסום CPI. הספייק חטף את הסטופ תוך שניות.\n\nהלקח: לוח אירועים פתוח תמיד. אין כניסות חדשות ב-15 הדקות שלפני נתון מאקרו.\n\nהוספתי את זה כחוק אישי במערכת.',
    page_type: 'journal', tags: ['לבדיקה', 'ניהול סיכונים'],
    created_at: iso(7, 20), updated_at: iso(7, 20),
  },
  {
    id: 'demo-note-3', user_id: DEMO_USER_ID,
    title: 'תובנה: השעה הראשונה שלי שווה זהב',
    content: 'ניתוח של 30 העסקאות האחרונות מראה פער עצום:\n\n- עסקאות בין 16:30–18:00: אחוז הצלחה 78%\n- עסקאות אחרי 20:00: אחוז הצלחה 40%\n\nהריכוז יורד והנטייה לאלתר עולה. המסקנה: את רוב הסיכון לוקחים בשעה הראשונה, אחרי 20:00 רק ניהול פוזיציות קיימות.',
    page_type: 'insights', tags: ['אסטרטגיה', 'חשוב'],
    created_at: iso(12, 22), updated_at: iso(9, 10),
  },
  {
    id: 'demo-note-4', user_id: DEMO_USER_ID,
    title: 'תוכנית מסחר — הרבעון הקרוב',
    content: 'יעדים:\n1. מקסימום 3 עסקאות ביום, בלי חריגות.\n2. יחס סיכון-סיכוי מינימלי 1.5 בכל סטאפ פריצה.\n3. שבוע ירוק = לא מגדילים סיכון. הגדלה רק אחרי חודש עקבי.\n\nכללי ברזל:\n- הסטופ לא זז. אף פעם.\n- אין מסחר ביום עם מצב רגשי מתחת ל-3.\n- כל עסקה מקבלת תחקיר, גם המנצחות.',
    page_type: 'plan', tags: ['חשוב', 'ניהול סיכונים'],
    created_at: iso(30, 19), updated_at: iso(14, 9),
  },
];

const DEMO_SETUPS = [
  {
    id: 'demo-setup-orb', user_id: DEMO_USER_ID,
    name: 'ORB — פריצת טווח פתיחה', symbol: 'NQ',
    description: 'טווח 30 הדקות הראשונות מוגדר; כניסה בפריצה עם ווליום, סטופ בצד השני של הטווח.',
    entry_conditions: 'נר 5 דקות סוגר מחוץ לטווח + ווליום מעל ממוצע 20',
    stop_loss: 'הקצה הנגדי של טווח הפתיחה',
    take_profit: 'פי 1.5–2 מגובה הטווח',
    market_context: 'עובד הכי טוב בימי מגמה אחרי נתוני מאקרו',
    image_url: null,
    created_at: '2026-02-05T09:00:00.000Z', updated_at: iso(6, 12),
  },
  {
    id: 'demo-setup-vwap', user_id: DEMO_USER_ID,
    name: 'VWAP Reversion', symbol: 'ES',
    description: 'חזרה ל-VWAP אחרי מתיחה קיצונית, בכיוון המגמה היומית בלבד.',
    entry_conditions: 'מרחק 2 סטיות תקן מ-VWAP + נר היפוך',
    stop_loss: 'מעבר לקיצון המתיחה',
    take_profit: 'נגיעה ב-VWAP',
    market_context: 'ימי דשדוש עם טווח מוגדר — לא בימי מגמה חזקה',
    image_url: null,
    created_at: '2026-03-12T09:00:00.000Z', updated_at: iso(11, 12),
  },
];

// trades flagged fomo/revenge get a matching rule_violations row (drives the ⚠ flag)
const DEMO_RULE_VIOLATIONS = DEMO_TRADES
  .filter(t => t.fomo_entry || t.revenge_trade)
  .map((t, i) => ({
    id: `demo-violation-${i + 1}`,
    user_id: DEMO_USER_ID,
    trade_plan_id: t.id,
    rule_source: 'custom',
    custom_rule_id: t.revenge_trade ? 'demo-rule-2' : 'demo-rule-3',
    rule_key: t.revenge_trade ? 'loss_streak' : 'fomo_last_trade',
    rule_name: t.revenge_trade ? 'עצירה אחרי 2 הפסדים רצופים' : 'אזהרה אחרי כניסת FOMO',
    outcome: 'overridden',
    created_at: t.submitted_at,
  }));

/** Table name → fixture rows, consumed by the demo query stub. */
export const DEMO_TABLES: Record<string, Record<string, unknown>[]> = {
  profiles: [DEMO_PROFILE],
  trade_plans: DEMO_TRADES,
  rule_violations: DEMO_RULE_VIOLATIONS,
  preset_rules: [DEMO_PRESET_RULES],
  custom_rules: DEMO_CUSTOM_RULES,
  personal_strategies: DEMO_STRATEGIES,
  notebook_pages: DEMO_NOTEBOOK_PAGES,
  setups: DEMO_SETUPS,
  alert_settings: [],
  weekly_summaries: [],
  streaks: [],
  ai_insights: [],
};

// ── Canned AI responses (served by the demo fetch interceptor — no API calls) ──

export const DEMO_DEBRIEF_RESULT = {
  summary: 'עסקה מתוכננת היטב: כניסה לפי הסטאפ, סטופ במקום הנכון ויציאה ביעד המקורי. התהליך היה נקי גם אם התוצאה הייתה יכולה להיות שונה.',
  worked: 'חיכית לאישור לפני הכניסה ולא הזזת את הסטופ — בדיוק לפי כללי האסטרטגיה שהגדרת.',
  improve: 'הגודל היה בקצה העליון של הסיכון המותר. שקול להקטין חוזה אחד בימים עם תנודתיות גבוהה.',
  lesson: 'עקביות בתהליך חשובה מהתוצאה של עסקה בודדת — ציון תהליך גבוה לאורך זמן מתורגם לרווחיות.',
  score: 86,
  documented: true,
};

// Numbers below are DERIVED from DEMO_TRADES with the app's canonical pnl
// helpers, so the coach content can never contradict the dashboard/stats.
const CLOSED = DEMO_TRADES.filter(t => t.status === 'closed' && t.exit_price != null);
const DEMO_WIN_RATE = Math.round(
  (CLOSED.filter(t => isWinningTrade(t)).length / Math.max(CLOSED.length, 1)) * 100,
);
const avgScore = (rows: typeof DEMO_TRADES) => {
  const scored = rows.filter(t => t.plan_score != null);
  return scored.length > 0
    ? Math.round(scored.reduce((s, t) => s + Number(t.plan_score), 0) / scored.length)
    : 0;
};
const DEMO_SCORE_FOLLOWED = avgScore(CLOSED.filter(t => t.followed_plan !== false));
const DEMO_SCORE_IMPULSIVE = avgScore(CLOSED.filter(t => t.followed_plan === false));
const stratPnl = (name: string) =>
  CLOSED.filter(t => t.strategy === name).reduce((s, t) => s + tradeMoneyPnl(t), 0);
const DEMO_TOP_STRATEGY = stratPnl(STRAT_NAMES[0]) >= stratPnl(STRAT_NAMES[1]) ? STRAT_NAMES[0] : STRAT_NAMES[1];
const DEMO_VIOLATION_COUNT = DEMO_RULE_VIOLATIONS.length;
const DEMO_ORB_COUNT = CLOSED.filter(t => t.strategy === STRAT_NAMES[0]).length;

export const DEMO_COACH_INSIGHTS = [
  { type: 'time', text: 'רוב הרווח שלך נוצר בשעה הראשונה של המסחר — בשעות המאוחרות אחוז ההצלחה יורד משמעותית. שקול לרכז את הכניסות החדשות בשעה הראשונה בלבד.' },
  { type: 'discipline', text: `בעסקאות שבוצעו לפי התוכנית ציון התהליך הממוצע שלך הוא ${DEMO_SCORE_FOLLOWED}, לעומת ${DEMO_SCORE_IMPULSIVE} בעסקאות האימפולסיביות. עם אחוז הצלחה כולל של ${DEMO_WIN_RATE}% — המשמעת שלך שווה כסף אמיתי.` },
  { type: 'performance', text: `אסטרטגיית "${DEMO_TOP_STRATEGY}" מניבה את הרווח הכולל הגבוה ביותר. שקול להקצות לה משקל גדול יותר בתוכנית השבועית.` },
];

export const DEMO_PATTERNS = [
  {
    type: 'emotional', severity: 'medium',
    title: 'כניסות אימפולסיביות אחרי הפסד',
    description: 'זוהו עסקאות שנפתחו זמן קצר אחרי סטופ, עם ציון תהליך נמוך משמעותית מהממוצע שלך.',
    occurrences: DEMO_VIOLATION_COUNT,
    recommendation: 'חוק העצירה אחרי 2 הפסדים כבר פעיל — ההמלצה היא להוריד את הסף להפסד אחד ביום תנודתי.',
  },
  {
    type: 'positive', severity: 'low',
    title: 'עקביות גבוהה בסטאפ הפריצה',
    description: 'עסקאות פריצת הפתיחה מבוצעות כמעט תמיד לפי הכללים: אישור ווליום, סטופ קבוע ויעד מוגדר מראש.',
    occurrences: DEMO_ORB_COUNT,
    recommendation: 'המשך לתעד כל פריצה — הדאטה מראה שזה הסטאפ החזק ביותר שלך.',
  },
];

// ── Canned weekly summary (mirrors /api/weekly-summary GET/POST shape) ───────

interface DailyPnl { date: string; pnl: number; trades: number }

function weekStartOf(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - r.getDay()); // back to Sunday
  return r;
}

function weeklyStatsFor(weekStart: Date) {
  const start = weekStart.getTime();
  const end = start + 7 * 86400_000;
  const rows = DEMO_TRADES.filter(t => {
    if (t.status !== 'closed' || !t.closed_at) return false;
    const ts = new Date(t.closed_at).getTime();
    return ts >= start && ts < end;
  });
  const winning = rows.filter(t => (t.actual_pnl ?? 0) > 0);
  const losing = rows.filter(t => (t.actual_pnl ?? 0) < 0);
  const totalPnl = rows.reduce((s, t) => s + (t.actual_pnl ?? 0), 0);
  const scored = rows.filter(t => t.plan_score != null);

  const dayMap: Record<string, { pnl: number; trades: number }> = {};
  for (const t of rows) {
    const key = dateOnly(t.closed_at!);
    dayMap[key] = { pnl: (dayMap[key]?.pnl ?? 0) + (t.actual_pnl ?? 0), trades: (dayMap[key]?.trades ?? 0) + 1 };
  }
  const daily_pnl: DailyPnl[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    return { date: key, pnl: dayMap[key]?.pnl ?? 0, trades: dayMap[key]?.trades ?? 0 };
  });

  let best: typeof rows[number] | null = null;
  let worst: typeof rows[number] | null = null;
  for (const t of rows) {
    if (!best || (t.actual_pnl ?? 0) > (best.actual_pnl ?? 0)) best = t;
    if (!worst || (t.actual_pnl ?? 0) < (worst.actual_pnl ?? 0)) worst = t;
  }

  return {
    total_trades: rows.length,
    winning_trades: winning.length,
    losing_trades: losing.length,
    win_rate: rows.length > 0 ? Math.round((winning.length / rows.length) * 100) : null,
    total_pnl: totalPnl,
    pnl_currency: '₪',
    avg_process_score: scored.length > 0
      ? Math.round(scored.reduce((s, t) => s + Number(t.plan_score), 0) / scored.length)
      : null,
    daily_pnl,
    avg_emotional_state: rows.length > 0
      ? Math.round((rows.reduce((s, t) => s + t.emotional_state, 0) / rows.length) * 10) / 10
      : null,
    best_trade: best ? { strategy: best.strategy, pnl: best.actual_pnl ?? 0, date: dateOnly(best.closed_at!) } : null,
    worst_trade: worst ? { strategy: worst.strategy, pnl: worst.actual_pnl ?? 0, date: dateOnly(worst.closed_at!) } : null,
    most_used_strategy: STRAT_NAMES[0],
  };
}

export function demoWeeklySummaryResponse() {
  const weekStart = weekStartOf(new Date());
  const prevWeekStart = new Date(weekStart);
  prevWeekStart.setDate(prevWeekStart.getDate() - 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  return {
    summary: {
      week_start: weekStartStr,
      week_end: weekEndStr,
      // segmented by markdown headings — the dashboard renders only headed sections
      summary_text: [
        '### מה עבד השבוע',
        'שבוע של משמעת: רוב העסקאות בוצעו לפי התוכנית, עם ציון תהליך ממוצע גבוה ורווח נקי בשורה התחתונה. סטאפ הפריצה בשעה הראשונה המשיך להיות מקור הרווח המרכזי.',
        '### מה דורש שיפור',
        'עסקת נקמה אחת אחרי סטופ עלתה כסף מיותר — הדפוס זוהה ונחסם ביום שאחרי. שווה להוריד את סף חוק ה-Loss Streak ביום תנודתי.',
        '### פוקוס לשבוע הבא',
        'מקסימום 3 עסקאות ביום, בלי חריגות. להמשיך להתמקד בפריצות בשעה הראשונה — שם נמצא היתרון הסטטיסטי שלך.',
      ].join('\n'),
      stats: weeklyStatsFor(weekStart),
      created_at: new Date().toISOString(),
    },
    week_start: weekStartStr,
    week_end: weekEndStr,
    is_current_week: true,
    previous_stats: weeklyStatsFor(prevWeekStart),
    latest_week_start: weekStartStr,
  };
}
