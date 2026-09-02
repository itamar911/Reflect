import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { MAIN_CONTENT_ID } from '@/components/accessibility/SkipLink';
import { SiteDisclosureFooter } from '@/components/legal/SiteDisclosureFooter';
import '@/components/legal/legal.css';

/**
 * The privacy policy. Replaces the "בהכנה" placeholder that stood here while
 * the text was being drafted.
 *
 * The approved source document is the one authority for this wording — it was
 * written to cover תיקון 13 to the Israeli Privacy Protection Law and the
 * substance of GDPR art. 13, and it is also what clause 2(vi) of the
 * NinjaTrader API License Agreement obliges us to publish. Treat the copy the
 * way disclosureText.ts is treated: correct a typo, but do not paraphrase,
 * shorten or re-order a clause without the text being re-approved.
 *
 * LAST_UPDATED is a literal, not new Date(): it is the date this policy took
 * effect, which section 13 tells the reader to look at. Deriving it from the
 * render date would silently re-date an unchanged document on every deploy.
 *
 * Layout note: /terms is still a placeholder, so there was no long-form
 * treatment there to copy. This follows /risk-disclosure — the one real
 * long-form legal page in the repo — and keeps the shell /terms already has
 * (MAIN_CONTENT_ID, the centred column, the home link, SiteDisclosureFooter),
 * so the two land as a pair once /terms is written against this same shape.
 */
export const metadata: Metadata = {
  title: 'מדיניות פרטיות — Reflect',
  description:
    'איזה מידע Reflect אוסף, לשם מה, עם מי הוא משותף, וכיצד תוכלו לשלוט בו — לרבות חיבור לחשבון מסחר, שימוש בבינה מלאכותית וזכויותיכם לפי חוק הגנת הפרטיות.',
  alternates: { canonical: '/privacy' },
};

const LAST_UPDATED = '28 באוגוסט 2026';
const SUPPORT_EMAIL = 'support@reflecttrading.app';

export default function PrivacyPage() {
  return (
    <>
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        dir="rtl"
        className="max-w-[820px] mx-auto px-4 md:px-6 py-20 md:py-24 flex flex-col gap-10"
      >
        <header className="flex flex-col gap-3">
          <h1
            className="text-3xl md:text-4xl font-extrabold"
            style={{ color: 'var(--color-tg-text-2)' }}
          >
            מדיניות פרטיות
          </h1>
          <p className="text-xs font-normal" style={{ color: 'var(--color-tg-disclosure)' }}>
            עודכן לאחרונה: {LAST_UPDATED}
          </p>
        </header>

        <Section n={1} title="כללי">
          <P>
            Reflect (&quot;אנחנו&quot;, &quot;השירות&quot;) היא פלטפורמה לניהול יומן מסחר ומשמעת
            מסחר.
          </P>
          <P>
            מדיניות זו מסבירה איזה מידע אנחנו אוספים, לשם מה, עם מי הוא משותף, וכיצד תוכלו לשלוט
            בו. השימוש בשירות מהווה הסכמה למדיניות זו.
          </P>
          <P>
            <strong className="font-bold">
              ליצירת קשר בנושאי פרטיות: <SupportEmail />
            </strong>
          </P>
        </Section>

        <Section n={2} title="איזה מידע אנחנו אוספים">
          <H3>2.1 מידע שאתם מוסרים לנו</H3>
          <UL>
            <li>
              <strong className="font-bold">פרטי חשבון</strong>{' '} — כתובת דוא&quot;ל, שם, וסיסמה.
              הסיסמה נשמרת מוצפנת בפונקציית גיבוב חד-כיוונית ואינה ניתנת לשחזור, גם לא על ידינו
            </li>
            <li>
              <strong className="font-bold">פרטי תשלום</strong>{' '}
              — עם הפעלת התשלומים בשירות, הם יעובדו ישירות על ידי Stripe.{' '}
              <strong className="font-bold">
                איננו מקבלים ואיננו מאחסנים מספרי כרטיס אשראי בשום שלב.
              </strong>
            </li>
            <li>
              <strong className="font-bold">תוכן שאתם מזינים</strong> — עסקאות, כללי משמעת, הערות,
              מצב רגשי, דיבריפים, וצילומי גרפים שאתם מעלים
            </li>
          </UL>

          <H3>2.2 מידע מחשבונות מסחר מחוברים</H3>
          <P>
            אם תבחרו לחבר חשבון מסחר (ראו סעיף 4), אנחנו מקבלים מהפלטפורמה{' '}
            <strong className="font-bold">בגישת קריאה בלבד</strong>:
          </P>
          <UL>
            <li>עסקאות שבוצעו — סימבול, כיוון, כמות, מחירי כניסה ויציאה, זמנים</li>
            <li>פוזיציות פתוחות</li>
            <li>סטטוס פקודות</li>
            <li>נתוני חשבון בסיסיים — יתרה, מטבע, מזהה חשבון</li>
          </UL>
          <P>
            <strong className="font-bold">
              איננו מבצעים פעולות בחשבון שלכם, איננו שולחים פקודות, ואיננו מנהלים פוזיציות.
            </strong>
          </P>

          <H3>2.3 מידע טכני שנאסף אוטומטית</H3>
          <UL>
            <li>כתובת IP, סוג דפדפן ומכשיר, מערכת הפעלה</li>
            <li>עמודים שנצפו ופעולות שבוצעו בשירות</li>
            <li>עוגיות הכרחיות בלבד — ראו סעיף 9</li>
          </UL>
        </Section>

        <Section n={3} title="מטרות העיבוד והבסיס החוקי">
          <div className="legal-table-scroll">
            <table className="legal-table">
              {/* Visually hidden — the section heading above already names the
                  table, so a visible caption would print it twice. Same call as
                  PerformanceTable. */}
              <caption className="sr-only">מטרות העיבוד והבסיס החוקי לכל מטרה</caption>
              <thead>
                <tr>
                  <th scope="col">המטרה</th>
                  <th scope="col">הבסיס החוקי</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>אספקת השירות — יומן, כללים, סטטיסטיקות, ציוני משמעת</td>
                  <td>ביצוע חוזה</td>
                </tr>
                <tr>
                  <td>סנכרון עסקאות מחשבון המסחר שלכם</td>
                  <td>הסכמה מפורשת ונפרדת</td>
                </tr>
                <tr>
                  <td>ניתוח עסקאות והפקת תובנות באמצעות בינה מלאכותית</td>
                  <td>ביצוע חוזה</td>
                </tr>
                <tr>
                  <td>עיבוד תשלומים וניהול מנוי (בעת הפעלת התשלומים בשירות)</td>
                  <td>ביצוע חוזה</td>
                </tr>
                <tr>
                  <td>מיילים תפעוליים — התראות, איפוס סיסמה, עדכוני מנוי</td>
                  <td>ביצוע חוזה</td>
                </tr>
                <tr>
                  <td>אבטחת השירות ומניעת שימוש לרעה</td>
                  <td>אינטרס לגיטימי</td>
                </tr>
              </tbody>
            </table>
          </div>

          <H3 as="p">מה שאיננו עושים:</H3>
          <UL>
            <li>איננו מוכרים מידע אישי</li>
            <li>איננו משתפים מידע עם מפרסמים או רשתות פרסום</li>
            <li>איננו מבצעים שיווק מחדש (remarketing)</li>
            <li>
              <strong className="font-bold">איננו שולחים דיוור שיווקי.</strong> כל המיילים שתקבלו
              מאיתנו הם תפעוליים ונוגעים לחשבון שלכם
            </li>
          </UL>
        </Section>

        <Section n={4} title="חיבור לחשבון מסחר">
          <P>זהו החלק הרגיש ביותר בשירות, ולכן הוא מפורט בנפרד.</P>

          <H3>4.1 החיבור הוא בבחירתכם בלבד</H3>
          <P>
            השירות עובד במלואו גם ללא חיבור לחשבון מסחר, באמצעות הזנה ידנית. חיבור חשבון הוא פעולה
            נפרדת ואופציונלית, ואינו נכלל בהרשמה לשירות ואינו תנאי לשימוש בו.
          </P>

          <H3>4.2 מה מתרחש בעת החיבור</H3>
          <P>
            החיבור מתבצע דרך מסך ההתחברות של פלטפורמת המסחר עצמה (OAuth).{' '}
            <strong className="font-bold">
              איננו רואים ואיננו מאחסנים את שם המשתמש והסיסמה שלכם לחשבון המסחר.
            </strong>{' '}
            אנחנו מקבלים אסימון גישה (token) המוגבל לקריאה בלבד.
          </P>

          <H3>4.3 היקף ההרשאה</H3>
          <P>
            ההרשאה מוגבלת לקריאת נתוני המסחר המפורטים בסעיף 2.2. אין לנו הרשאה לבצע פעולות בחשבון,
            לשלוח פקודות או לנהל פוזיציות.
          </P>

          <H3>4.4 אחסון</H3>
          <P>
            אסימוני הגישה נשמרים מוצפנים. הגישה אליהם מוגבלת למערכת ואינה נגישה לצוות באופן שגרתי.
          </P>

          <H3>4.5 ניתוק</H3>
          <P>
            תוכלו לנתק את החשבון בכל עת. בעת הניתוק אסימון הגישה נמחק לאלתר. נתוני העסקאות שכבר
            סונכרנו נשארים ביומן שלכם, אלא אם תבקשו את מחיקתם.
          </P>
        </Section>

        <Section n={5} title="שימוש בבינה מלאכותית">
          <P>
            השירות כולל תכונות המבוססות על מודל שפה — מאמן AI, תחקיר עסקה וניתוח גרפים.
          </P>
          <P>
            <strong className="font-bold">מה נשלח:</strong> נתוני העסקאות שלכם, ההערות שרשמתם,
            וצילומי גרפים שהעליתם — לפי התכונה שהפעלתם.
          </P>
          <P>
            <strong className="font-bold">למי:</strong> Anthropic, ספקית מודל השפה.
          </P>
          <P>
            <strong className="font-bold">מה לא נשלח:</strong>{' '} שמכם, כתובת הדוא&quot;ל שלכם, פרטי
            התשלום שלכם, ואסימוני הגישה לחשבון המסחר.
          </P>
          <P>
            לפי תנאי השימוש המסחריים של Anthropic, נתונים הנשלחים דרך ה-API אינם משמשים לאימון
            מודלים.
          </P>
        </Section>

        <Section n={6} title="צדדים שלישיים">
          <div className="legal-table-scroll">
            <table className="legal-table">
              <caption className="sr-only">ספקי צד שלישי ותפקידם בשירות</caption>
              <thead>
                <tr>
                  <th scope="col">הספק</th>
                  <th scope="col">תפקיד</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Supabase</td>
                  <td>בסיס נתונים ואימות משתמשים</td>
                </tr>
                <tr>
                  <td>Vercel</td>
                  <td>אחסון ופריסת האתר</td>
                </tr>
                <tr>
                  <td>Cloudflare</td>
                  <td>DNS וניתוב דואר</td>
                </tr>
                <tr>
                  <td>Stripe</td>
                  <td>עיבוד תשלומים — יופעל עם פתיחת השירות לתשלום</td>
                </tr>
                <tr>
                  <td>Anthropic</td>
                  <td>עיבוד בינה מלאכותית</td>
                </tr>
                <tr>
                  <td>Resend</td>
                  <td>שליחת מיילים תפעוליים</td>
                </tr>
                <tr>
                  <td>פלטפורמות מסחר מחוברות</td>
                  <td>סנכרון עסקאות</td>
                </tr>
              </tbody>
            </table>
          </div>

          <P>כל ספק מקבל אך ורק את המידע הדרוש לתפקידו.</P>
          <P>מידע עשוי להימסר לרשויות אם נידרש לכך על פי צו שיפוטי או חובה חוקית.</P>
        </Section>

        <Section n={7} title="אבטחת מידע">
          <UL>
            <li>
              כל התקשורת עם השירות מוצפנת (<span className="legal-ltr">HTTPS/TLS</span>)
            </li>
            <li>סיסמאות נשמרות מוצפנות בפונקציית גיבוב חד-כיוונית</li>
            <li>אסימוני גישה לחשבונות מסחר נשמרים מוצפנים</li>
            <li>הרשאות גישה נאכפות ברמת בסיס הנתונים, כך שכל משתמש ניגש לנתוניו בלבד</li>
          </UL>
          <P>
            איננו יכולים להתחייב לאבטחה מוחלטת. אם ייוודע לנו על אירוע אבטחה שעלול לפגוע בכם, ניידע
            אתכם ואת הרשות להגנת הפרטיות כנדרש בדין.
          </P>
        </Section>

        <Section n={8} title="שמירת מידע ומחיקה">
          <UL>
            <li>
              <strong className="font-bold">מידע חשבון ונתוני מסחר</strong> — נשמרים כל עוד החשבון
              פעיל
            </li>
            <li>
              <strong className="font-bold">לאחר בקשת מחיקה</strong> — הנתונים נמחקים תוך 30 יום
            </li>
            <li>
              <strong className="font-bold">מידע חשבונאי</strong> — נשמר שבע שנים כנדרש בדיני המס
              בישראל
            </li>
          </UL>
          <P>
            <strong className="font-bold">למחיקת חשבון:</strong> יש לפנות בדוא&quot;ל לכתובת{' '}
            <SupportEmail />. נטפל בבקשה ונאשר את ביצועה.
          </P>
        </Section>

        <Section n={9} title="עוגיות">
          <P>
            אנחנו משתמשים <strong className="font-bold">בעוגיות הכרחיות בלבד</strong> — לשמירת מצב
            ההתחברות שלכם ולהעדפות בסיסיות בשירות.
          </P>
          <P>
            <strong className="font-bold">
              איננו משתמשים בעוגיות אנליטיקה, בעוגיות פרסום, או בפיקסלים של צדדים שלישיים.
            </strong>{' '}
            לא <span className="legal-ltr">Google Analytics</span>, לא{' '}
            <span className="legal-ltr">Meta Pixel</span>, ולא כלי מעקב אחרים.
          </P>
          <P>
            עוגיות הכרחיות אינן דורשות הסכמה מוקדמת לפי הדין. תוכלו לחסום עוגיות בהגדרות הדפדפן, אך
            הדבר עלול למנוע את פעולתו התקינה של השירות.
          </P>
        </Section>

        <Section n={10} title="הזכויות שלכם">
          <P>
            לפי חוק הגנת הפרטיות, התשמ&quot;א-1981 ותיקוניו, ובמידה שחלה עליכם רגולציית GDPR:
          </P>
          <UL>
            <li>
              <strong className="font-bold">עיון</strong> — לקבל עותק של המידע שאנחנו מחזיקים
              עליכם
            </li>
            <li>
              <strong className="font-bold">תיקון</strong> — לתקן מידע שגוי, לא שלם או לא מעודכן
            </li>
            <li>
              <strong className="font-bold">מחיקה</strong> — לבקש את מחיקת המידע
            </li>
            <li>
              <strong className="font-bold">ניידות</strong> — לקבל את הנתונים שלכם בפורמט מובנה
            </li>
            <li>
              <strong className="font-bold">הגבלת עיבוד והתנגדות</strong> — להתנגד לעיבוד מסוים או
              להגבילו
            </li>
            <li>
              <strong className="font-bold">ביטול הסכמה</strong> — בכל עת, מבלי לפגוע בחוקיות
              העיבוד שקדם לביטול
            </li>
          </UL>
          <P>
            <strong className="font-bold">לפנייה:</strong> <SupportEmail />. נשיב תוך 30 יום.
          </P>
          <P>אם אינכם מרוצים מהטיפול, תוכלו לפנות לרשות להגנת הפרטיות.</P>
        </Section>

        <Section n={11} title="העברת מידע מחוץ לישראל">
          <P>
            חלק מספקי השירות שלנו פועלים מחוץ לישראל, ולכן מידע עשוי להיות מועבר ומאוחסן מחוץ
            לגבולות ישראל. בשימוש בשירות אתם מסכימים להעברה ולאחסון אלה.
          </P>
          <P>בסיס הנתונים שבו נשמר המידע שלכם מאוחסן בסידני שבאוסטרליה.</P>
        </Section>

        <Section n={12} title="קטינים">
          <P>
            השירות מיועד לבני 18 ומעלה. איננו אוספים ביודעין מידע מקטינים. אם נודע לכם שקטין מסר
            לנו מידע, פנו אלינו ונמחק אותו.
          </P>
        </Section>

        <Section n={13} title="שינויים במדיניות">
          <P>
            נעדכן מדיניות זו מעת לעת. שינוי מהותי יובא לידיעתכם בדוא&quot;ל או בהודעה בשירות. תאריך
            העדכון האחרון מופיע בראש העמוד.
          </P>
        </Section>

        <Section n={14} title="יצירת קשר">
          <P>
            <strong className="font-bold">
              <SupportEmail />
            </strong>
          </P>
          <P>
            וואטסאפ: <span className="legal-ltr">050-225-5903</span>
          </P>
        </Section>

        <div className="flex flex-wrap gap-x-6 gap-y-2 pt-2">
          <Link href="/" className="text-tg-primary font-semibold">
            חזרה לעמוד הבית
          </Link>
          <Link href="/terms" className="text-tg-muted hover:text-tg-primary transition-colors">
            תנאי שימוש
          </Link>
          <Link
            href="/risk-disclosure"
            className="text-tg-muted hover:text-tg-primary transition-colors"
          >
            גילוי סיכון
          </Link>
        </div>
      </main>
      <SiteDisclosureFooter />
    </>
  );
}

/* ── Local typography ──────────────────────────────────────────────
   The scale /risk-disclosure sets (h1 3xl/4xl, body text-base in
   --color-tg-text, headings in --color-tg-text-2), with one level added:
   that page has no sub-headings, and this one needs h3 for 2.1–2.3 and
   4.1–4.5. Under the bumped scale in globals.css that resolves to
   24 / 20 / 18px, so each level stays visibly above the next.

   Factored into components rather than repeated inline purely because there
   are fourteen sections of it — the styles themselves are unchanged. */

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold" style={{ color: 'var(--color-tg-text-2)' }}>
        {n}. {title}
      </h2>
      {children}
    </section>
  );
}

/* `as="p"` for the one lead-in that reads like a heading but isn't a section
   of the document ("מה שאיננו עושים:") — styling it as an h3 would put a rung
   in the outline that the policy's own numbering doesn't have. */
function H3({ children, as = 'h3' }: { children: ReactNode; as?: 'h3' | 'p' }) {
  const Tag = as;
  return (
    <Tag className="text-lg font-bold mt-3" style={{ color: 'var(--color-tg-text-2)' }}>
      {children}
    </Tag>
  );
}

function P({ children }: { children: ReactNode }) {
  return (
    <p className="text-base leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
      {children}
    </p>
  );
}

/* ps-5, not pl/pr: the marker has to sit on the start edge, which is the right
   one here and would flip correctly in an LTR subtree. */
function UL({ children }: { children: ReactNode }) {
  return (
    <ul
      className="text-base leading-relaxed list-disc ps-5 flex flex-col gap-2"
      style={{ color: 'var(--color-tg-text)' }}
    >
      {children}
    </ul>
  );
}

/* Isolated because the address is bounded by neutrals (@ and .) — inside an
   RTL line those take the paragraph's direction and drag the address apart. */
function SupportEmail() {
  return (
    <a
      href={`mailto:${SUPPORT_EMAIL}`}
      className="legal-ltr underline underline-offset-2 transition-colors hover:text-tg-primary"
      style={{ color: 'inherit' }}
    >
      {SUPPORT_EMAIL}
    </a>
  );
}
