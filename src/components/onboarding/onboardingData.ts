export type ChallengeId = 'revenge' | 'early_exit' | 'overtrading' | 'rule_breaking' | 'fear_entry';
export type AfterLossId = 'immediate_revenge' | 'stop_for_day' | 'no_change' | 'lose_confidence';

export const CHALLENGE_OPTIONS: { id: ChallengeId; label: string }[] = [
  { id: 'revenge', label: 'Revenge Trading אחרי הפסד' },
  { id: 'early_exit', label: 'יוצא מוקדם מדי מרווחים' },
  { id: 'overtrading', label: 'מסחר יתר (Over-trading)' },
  { id: 'rule_breaking', label: 'לא עומד בכללים שקבעתי לעצמי' },
  { id: 'fear_entry', label: 'פחד להיכנס לעסקאות' },
];

export const AFTER_LOSS_OPTIONS: { id: AfterLossId; label: string }[] = [
  { id: 'immediate_revenge', label: 'מנסה "להחזיר" מיד עם עסקה נוספת' },
  { id: 'stop_for_day', label: 'עוצר ומפסיק למשך היום' },
  { id: 'no_change', label: 'ממשיך כרגיל ללא שינוי' },
  { id: 'lose_confidence', label: 'מאבד ביטחון ונכנס לספק עצמי' },
];

export interface TraderAnalysis {
  traderType: string;
  traderTypeHebrew: string;
  description: string;
  weaknesses: [string, string];
  firstTip: string;
}

// Used when the AI analysis call fails — keyed off the trader's own answer to
// "biggest challenge" so the fallback still feels relevant to them.
export const FALLBACK_ANALYSIS: Record<ChallengeId, TraderAnalysis> = {
  revenge: {
    traderType: 'The Revenge Trader',
    traderTypeHebrew: 'הנוקם',
    description: 'הפסד אחד גורם לך לרצות "להחזיר" אותו מיד — וזה בדיוק מה שעולה לך הכי הרבה כסף.',
    weaknesses: ['קושי להפריד בין רגש להחלטה', 'נכנס לעסקאות בלי תוכנית אחרי הפסד'],
    firstTip: 'קבע כלל נעילה: אחרי הפסד, חכה 30 דקות לפני שתבדוק את השוק שוב.',
  },
  early_exit: {
    traderType: 'The Impatient Trader',
    traderTypeHebrew: 'חסר הסבלנות',
    description: 'אתה בורח מרווחים לפני שהם הספיקו לגדול, ומשאיר כסף על השולחן בכל עסקה.',
    weaknesses: ['חוסר אמון בתוכנית המקורית', 'נסגר על רווח קטן מפחד שהוא ייעלם'],
    firstTip: 'הגדר מראש Take Profit אוטומטי ואל תיגע בו עד שהוא מופעל.',
  },
  overtrading: {
    traderType: 'The Overtrader',
    traderTypeHebrew: 'הסוחר הכפייתי',
    description: 'אתה פשוט סוחר יותר מדי — וכל עסקה נוספת מקטינה את הסיכוי שלך לרווח אמיתי.',
    weaknesses: ['קושי לשבת על הידיים', 'מבלבל פעילות עם תוצאה'],
    firstTip: 'קבע מספר עסקאות מקסימלי ליום, וכשהוא מסתיים — המחשב נסגר.',
  },
  rule_breaking: {
    traderType: 'The Rule Breaker',
    traderTypeHebrew: 'שובר הכללים',
    description: 'אתה כותב כללים מצוינים — ואז שוכח אותם בדיוק ברגע שהם הכי חשובים.',
    weaknesses: ['פער בין תכנון לביצוע', 'ביטחון עצמי שמתעלם מהתוכנית'],
    firstTip: 'תעד כל הפרת כלל ברגע שהיא קורית, לא בסוף היום — הזיכרון מטעה.',
  },
  fear_entry: {
    traderType: 'The Fearful Trader',
    traderTypeHebrew: 'הפחדן',
    description: 'אתה מהסס כל כך הרבה שההזדמנויות הטובות עוברות לידך לפני שאתה בכלל נכנס.',
    weaknesses: ['חיפוש ביטחון מוחלט במקום ניהול סיכון', 'פספוס נקודות כניסה איכותיות'],
    firstTip: 'הגדר תנאי כניסה ברורים מראש, וברגע שהם מתקיימים — תיכנס בלי לחשוב פעמיים.',
  },
};

// Red for revenge/fear-driven types, orange for overtraders, turquoise (default) for everyone else.
export function traderThemeColor(traderType: string): string {
  const t = traderType.toLowerCase();
  if (t.includes('revenge') || t.includes('fear')) return '#ef4444';
  if (t.includes('overtrad')) return '#f97316';
  return '#00d2d2';
}
