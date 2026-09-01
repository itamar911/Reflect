import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { MAIN_CONTENT_ID } from '@/components/accessibility/SkipLink';
import { SiteDisclosureFooter } from '@/components/legal/SiteDisclosureFooter';
import '@/components/legal/legal.css';

/**
 * The terms of service. Replaces the "בהכנה" placeholder that stood here while
 * the text was being drafted.
 *
 * The approved source document is the one authority for this wording. Treat the
 * copy the way disclosureText.ts and /privacy are treated: correct a typo, but
 * do not paraphrase, shorten or re-order a clause without the text being
 * re-approved. Section 9 (הגבלת אחריות) in particular is the service's central
 * legal protection and is worded as counsel approved it.
 *
 * LAST_UPDATED is a literal, not new Date(): it is the date these terms took
 * effect, which section 12 tells the reader to look at. Deriving it from the
 * render date would silently re-date an unchanged document on every deploy.
 *
 * Layout is /privacy's, deliberately — that page was built as the template for
 * this one, down to the 820px column, the gap-10 section rhythm, the local
 * typography components below and the legal.css import.
 */
export const metadata: Metadata = {
  title: 'תנאי שימוש — Reflect',
  description:
    'התנאים המסדירים את השימוש ב-Reflect — מה השירות עושה ומה אינו, מנוי ותשלום, חיבור חשבונות מסחר, מנגנון הכללים, תכונות בינה מלאכותית והגבלת אחריות.',
  alternates: { canonical: '/terms' },
};

const LAST_UPDATED = '1 בספטמבר 2026';
const SUPPORT_EMAIL = 'support@reflecttrading.app';

export default function TermsPage() {
  return (
    <>
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        dir="rtl"
        className="max-w-[820px] mx-auto px-4 md:px-6 py-20 md:py-24 flex flex-col gap-10"
      >
        <header className="flex flex-col gap-3">
          {/* Not text-white: globals.css defines a light theme in which
              --color-tg-text-2 is #3e4451, and a white heading vanished
              against it. Same token, same scale as the h1 on /privacy. */}
          <h1
            className="text-3xl md:text-4xl font-extrabold"
            style={{ color: 'var(--color-tg-text-2)' }}
          >
            תנאי שימוש
          </h1>
          <p className="text-xs font-normal" style={{ color: 'var(--color-tg-disclosure)' }}>
            עודכן לאחרונה: {LAST_UPDATED}
          </p>
        </header>

        <Section n={1} title="כללי">
          <P>
            תנאים אלה מסדירים את השימוש בשירות Reflect (&quot;השירות&quot;, &quot;אנחנו&quot;).
          </P>
          <P>
            השימוש בשירות, ההרשמה אליו או הגלישה באתר מהווים הסכמה מלאה לתנאים אלה. מי שאינו מסכים
            להם מתבקש שלא לעשות שימוש בשירות.
          </P>
          <P>התנאים מנוסחים בלשון זכר מטעמי נוחות בלבד ומתייחסים לכל המגדרים.</P>
          <P>
            <strong className="font-bold">ליצירת קשר: <SupportEmail /></strong>
          </P>
        </Section>

        <Section n={2} title="מה השירות עושה — ומה הוא אינו עושה">
          <H3>2.1 מה השירות עושה</H3>
          <P>
            Reflect היא פלטפורמה לתיעוד מסחר ולניהול משמעת מסחר. השירות מאפשר לתעד עסקאות, להגדיר
            כללי סיכון אישיים, לקבל ציוני משמעת, ולנתח דפוסי התנהגות לאורך זמן.
          </P>

          <H3>2.2 מה השירות אינו</H3>
          <P>
            <strong className="font-bold">
              זהו החלק החשוב ביותר בתנאים אלה, ואנחנו מבקשים שתקראו אותו בעיון.
            </strong>
          </P>
          <UL>
            <li>
              <strong className="font-bold">Reflect אינו ברוקר ואינו זירת מסחר.</strong> איננו
              מבצעים עסקאות, איננו מחזיקים כספים, ואיננו מספקים גישה לשווקים
            </li>
            <li>
              <strong className="font-bold">
                Reflect אינו מספק ייעוץ השקעות, שיווק השקעות או ניהול תיקים
              </strong>
              , ואינו מחזיק ברישיון לכך. שום דבר בשירות אינו המלצה לבצע עסקה או להימנע ממנה
            </li>
            <li>
              <strong className="font-bold">Reflect אינו מבטיח שיפור בביצועים.</strong> המערכת
              מודדת התנהגות, לא תוצאות
            </li>
            <li>
              <strong className="font-bold">הכללים שאתם מגדירים הם שלכם.</strong> אנחנו מספקים את
              הכלי לאכיפתם, לא קובעים אותם ולא בודקים אם הם נכונים עבורכם
            </li>
          </UL>
          <P>
            <strong className="font-bold">האחריות על כל החלטת מסחר היא שלכם בלבד.</strong>
          </P>

          <H3>2.3 מסחר כרוך בסיכון</H3>
          <P>
            מסחר בחוזים עתידיים, במט&quot;ח, במניות ובנגזרים כרוך בסיכון משמעותי ואינו מתאים לכל
            אדם. אתם עלולים לאבד את מלוא ההשקעה ואף יותר ממנה. ביצועי עבר אינם מעידים על תוצאות
            עתידיות.
          </P>
        </Section>

        <Section n={3} title="הרשמה וחשבון">
          <P>3.1 השירות מיועד לבני 18 ומעלה.</P>
          <P>3.2 עליכם למסור פרטים נכונים ומלאים בעת ההרשמה, ולעדכן אותם בעת שינוי.</P>
          <P>3.3 החשבון הוא אישי. אין להעביר אותו, לשתף אותו או לאפשר לאחר להשתמש בו.</P>
          <P>
            3.4 אתם אחראים לשמירת סודיות פרטי הכניסה שלכם ולכל פעולה שתתבצע בחשבונכם. אם נודע לכם
            על שימוש בלתי מורשה — יש להודיע לנו מיד.
          </P>
        </Section>

        <Section n={4} title="תקופת ניסיון, מנוי ותשלום">
          <H3>4.1 תקופת ניסיון</H3>
          <P>
            השירות מוצע בתקופת ניסיון בת 5 ימים ללא עלות וללא צורך בכרטיס אשראי. בתום התקופה לא
            יבוצע חיוב אוטומטי — המשך השימוש מותנה ברכישת מנוי יזומה.
          </P>

          <H3>4.2 מסלולים ותשלום</H3>
          <P>השירות מוצע בשני מסלולים, חודשי או שנתי, במחירים המפורסמים באתר.</P>
          <P>
            עם הפעלת התשלומים בשירות, התשלום יתבצע מראש עבור תקופת המנוי, ויעובד באמצעות Stripe.
          </P>

          <H3>4.3 חידוש</H3>
          <P>המנוי מתחדש אוטומטית בתום כל תקופה, אלא אם בוטל לפני מועד החידוש.</P>

          <H3>4.4 ביטול והחזרים</H3>
          <P>
            <strong className="font-bold">
              בהתאם לחוק הגנת הצרכן, התשמ&quot;א-1981, מדובר בעסקה מתמשכת וניתן לבטלה בכל עת.
            </strong>
          </P>
          <P>
            <strong className="font-bold">החזר מלא ב-14 הימים הראשונים.</strong> אם תבטלו את המנוי
            בתוך 14 יום ממועד הרכישה, תקבלו החזר מלא — בלי שאלות ובלי דמי ביטול.
          </P>
          <P>
            <strong className="font-bold">ביטול לאחר מכן.</strong> לא יבוצע חיוב נוסף, והגישה
            לשירות תימשך עד תום התקופה ששולמה. לא יינתן החזר על יתרת התקופה.
          </P>
          <P>
            הביטול ייכנס לתוקף תוך שלושה ימי עסקים ממועד קבלת ההודעה. ניתן לבטל בפנייה לכתובת{' '}
            <SupportEmail />.
          </P>

          <H3>4.5 שינויי מחיר</H3>
          <P>נודיע על שינוי מחיר לפחות 30 יום מראש. שינוי לא יחול על תקופה ששולמה מראש.</P>
        </Section>

        <Section n={5} title="חיבור חשבונות מסחר">
          <P>
            5.1 השירות מאפשר לחבר חשבונות מפלטפורמות מסחר נתמכות, לצורך סנכרון אוטומטי של עסקאות.{' '}
            <strong className="font-bold">החיבור אופציונלי ואינו תנאי לשימוש בשירות.</strong>
          </P>
          <P>
            5.2 היקף החיבור, אופן ההרשאה, ותדירות הסנכרון משתנים בין פלטפורמה לפלטפורמה. הפרטים
            המדויקים לכל פלטפורמה מוצגים במסך החיבור.
          </P>
          <P>
            5.3 <strong className="font-bold">הסנכרון תלוי בצד שלישי.</strong> זמינות הנתונים,
            שלמותם ועיתוי הגעתם תלויים בפלטפורמת המסחר ואינם בשליטתנו. ייתכנו עיכובים, פערים או
            תקלות בסנכרון.
          </P>
          <P>
            5.4{' '}
            <strong className="font-bold">
              אתם אחראים לוודא שחיבור השירות אינו מפר את תנאי ההתקשרות שלכם מול פלטפורמת המסחר.
            </strong>
          </P>
          <P>5.5 ניתן לנתק חשבון מחובר בכל עת מתוך הגדרות השירות.</P>
        </Section>

        <Section n={6} title="מנגנון הכללים והאכיפה">
          <P>
            6.1 השירות מאפשר להגדיר כללי משמעת אישיים ולבחור את רמת האכיפה שלהם — התראה, אזהרה
            הדורשת אישור, או חסימה.
          </P>
          <P>
            6.2 <strong className="font-bold">האכיפה פועלת בתוך השירות בלבד.</strong> היא אינה
            חוסמת אתכם מלסחור ישירות בפלטפורמת המסחר, ואינה מתערבת בחשבון המסחר שלכם.
          </P>
          <P>
            6.3 <strong className="font-bold">המנגנון אינו ערובה.</strong> ייתכנו תקלות טכניות,
            עיכובים, נתונים חסרים או מצבים שבהם הכלל לא נאכף. אין להסתמך עליו כאמצעי בטיחות יחיד.
          </P>
          <P>6.4 האחריות על עמידה בכללים שלכם היא שלכם. השירות הוא כלי עזר בלבד.</P>
        </Section>

        <Section n={7} title="תכונות מבוססות בינה מלאכותית">
          <P>
            7.1 השירות כולל תכונות המבוססות על מודלי שפה — מאמן AI, תחקיר עסקה וניתוח גרפים.
          </P>
          <P>
            7.2{' '}
            <strong className="font-bold">
              פלט של מודל שפה עלול להיות שגוי, חלקי או מטעה.
            </strong>{' '}
            התובנות שמוצגות הן ניתוח אוטומטי של הנתונים שלכם, ואינן ייעוץ מכל סוג.
          </P>
          <P>7.3 אין להסתמך על פלט זה כבסיס יחיד להחלטת מסחר.</P>
        </Section>

        <Section n={8} title="שימוש מותר ואסור">
          <P>
            <strong className="font-bold">מותר:</strong> להשתמש בשירות למטרותיו — תיעוד וניתוח
            המסחר האישי שלכם.
          </P>

          <H3 as="p">אסור:</H3>
          <UL>
            <li>להשתמש בחשבון של אחר או לשתף את חשבונכם</li>
            <li>
              לנסות לחדור למערכות, לעקוף מנגנוני אבטחה או להפעיל כלים אוטומטיים לגריפת מידע
            </li>
            <li>להעתיק, לשכפל, להנדס לאחור או לנסות לחלץ את קוד המקור</li>
            <li>להשתמש בשירות באופן שמפר דין, פוגע בזכויות אחרים או מכביד על המערכת</li>
            <li>להציג את השירות כשלכם או למכור גישה אליו</li>
          </UL>
          <P>הפרה מהותית עלולה להוביל להשעיית החשבון או לסגירתו, ללא החזר.</P>
        </Section>

        <Section n={9} title="הגבלת אחריות">
          <P>
            <strong className="font-bold">סעיף זה מהותי להסכם.</strong>
          </P>
          <P>
            9.1 השירות ניתן כמות שהוא (<span className="legal-ltr">AS IS</span>). איננו מתחייבים
            שהוא יתאים לצרכיכם, יפעל ללא הפרעות או יהיה נקי מתקלות.
          </P>
          <P>
            9.2 <strong className="font-bold">איננו אחראים להפסדי מסחר.</strong> בכל מקרה, ובכלל זה
            תקלה בשירות, כשל באכיפת כלל, נתונים שגויים או חסרים, עיכוב בסנכרון, או פלט שגוי של מודל
            שפה — האחריות על החלטות המסחר ועל תוצאותיהן היא שלכם בלבד.
          </P>
          <P>
            9.3 איננו אחראים לנזק עקיף, תוצאתי או מיוחד, לרבות אובדן רווחים, אובדן הזדמנות או אובדן
            נתונים.
          </P>
          <P>
            9.4 בכל מקרה, גבול האחריות המצטברת שלנו כלפיכם לא יעלה על הסכום ששילמתם לנו בפועל
            בשלושת החודשים שקדמו לאירוע.
          </P>
          <P>9.5 אין באמור כדי לגרוע מאחריות שלא ניתן להגבילה על פי דין.</P>
        </Section>

        <Section n={10} title="זמינות השירות">
          <P>10.1 נשתדל לספק שירות רציף, אך איננו מתחייבים לזמינות מלאה.</P>
          <P>10.2 ייתכנו הפסקות לצורך תחזוקה, עדכונים או מסיבות שאינן בשליטתנו.</P>
          <P>
            10.3 השירות תלוי בספקי צד שלישי (אחסון, בסיס נתונים, פלטפורמות מסחר, ספקי בינה
            מלאכותית). תקלה אצלם עלולה להשפיע על זמינות השירות.
          </P>
        </Section>

        <Section n={11} title="תוכן וקניין רוחני">
          <P>
            11.1 <strong className="font-bold">הנתונים שלכם שייכים לכם</strong> — העסקאות, ההערות
            והכללים שהזנתם. אנחנו משתמשים בהם רק כדי לספק לכם את השירות, כמפורט במדיניות הפרטיות.
          </P>
          <P>
            11.2 <strong className="font-bold">השירות שייך לנו</strong> — הקוד, העיצוב, המותג,
            השיטה והתכנים. אין להעתיק, להפיץ או לעשות בהם שימוש מסחרי ללא אישור בכתב.
          </P>
          <P>11.3 בעת סגירת חשבון תוכלו לבקש עותק של הנתונים שלכם.</P>
        </Section>

        <Section n={12} title="שינויים בשירות ובתנאים">
          <P>12.1 אנחנו רשאים לשנות, להוסיף או להסיר תכונות מהשירות.</P>
          <P>
            12.2 שינוי מהותי בתנאים יובא לידיעתכם בדוא&quot;ל או בהודעה בשירות, לפחות 14 יום מראש.
          </P>
          <P>
            12.3 המשך שימוש לאחר כניסת השינוי לתוקף מהווה הסכמה לו. מי שאינו מסכים רשאי לבטל את
            המנוי.
          </P>
        </Section>

        <Section n={13} title="סיום ההתקשרות">
          <P>
            13.1 תוכלו לסגור את חשבונכם בכל עת בפנייה לכתובת <SupportEmail />.
          </P>
          <P>
            13.2 אנחנו רשאים להשעות או לסגור חשבון במקרה של הפרה מהותית של תנאים אלה, של פעילות
            בלתי חוקית, או של שימוש הפוגע בשירות או במשתמשים אחרים.
          </P>
          <P>
            13.3 עם סגירת החשבון תיפסק הגישה לשירות. מחיקת הנתונים מתבצעת כמפורט במדיניות הפרטיות.
          </P>
        </Section>

        <Section n={14} title="דין וסמכות שיפוט">
          <P>
            על תנאים אלה יחולו דיני מדינת ישראל בלבד. סמכות השיפוט הבלעדית נתונה לבתי המשפט
            המוסמכים במחוז הדרום, באר שבע.
          </P>
        </Section>

        <Section n={15} title="יצירת קשר">
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
          <Link href="/privacy" className="text-tg-muted hover:text-tg-primary transition-colors">
            מדיניות פרטיות
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
   Identical to /privacy's — that page is the template for this one, and the
   two are meant to read as a pair. Kept as a local copy rather than lifted
   into a shared module: they are four one-line style wrappers, and a shared
   legal/typography.tsx would couple the two documents' visual scale together
   at exactly the point where one might later need to diverge. */

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
   of the document ("אסור:") — styling it as an h3 would put a rung in the
   outline that the document's own numbering doesn't have. Same call /privacy
   makes for "מה שאיננו עושים:". */
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
