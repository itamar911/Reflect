// Shared instruction fragment for every AI prompt that should return prose —
// defined once so wording can't drift between routes the way it had before
// (ai-debrief, ai-chat, and onboarding-analysis had each written their own
// slightly different "no markdown" sentence). Append it to the end of any
// prompt whose output — including string fields inside a JSON response —
// should read as clean Hebrew prose. Do not use it on ai-chart or
// weekly-summary: those two intentionally use ##/** as a structural wire
// format that their renderers parse into cards/sections.
export const PLAIN_HEBREW_PROSE_CLAUSE =
  `כל טקסט חופשי בתשובה (כולל כל שדה טקסטואלי בתוך JSON, אם יש) חייב להיות ` +
  `בעברית תקנית, רהוטה ומקצועית, בפרוזה רציפה בלבד — בדיוק כמו טקסט ייעוץ ` +
  `כתוב בידי איש מקצוע. אסור בהחלט להשתמש בכל צורה של Markdown או סימון ` +
  `טכני: לא כותרות עם # או ##, לא הדגשות עם ** או *, לא רשימות עם מקפים (-), ` +
  `כוכביות (*) או תבליטים (•), לא מספור של רשימה, לא האשטגים (#), ולא ` +
  `אימוג'ים או אייקונים מכל סוג. אם יש כמה נקודות לציין, שלב אותן בזרימה ` +
  `טבעית של משפטים בתוך פסקאות — ולא כרשימה.`;
