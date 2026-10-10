import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { MAIN_CONTENT_ID } from '@/components/accessibility/SkipLink';
import { SiteDisclosureFooter } from '@/components/legal/SiteDisclosureFooter';
import '@/components/legal/legal.css';

/**
 * The accessibility statement (REF-7).
 *
 * The approved source document is the one authority for this wording — it is
 * what ת"י 5568 and the accessibility regulations oblige us to publish, and it
 * is the document a complaint would be measured against. Treat the copy the
 * way disclosureText.ts, /privacy and /terms are treated: correct a typo, but
 * do not paraphrase, shorten or re-order a clause without the text being
 * re-approved.
 *
 * LAST_UPDATED is a literal, not new Date(): it is the date the statement was
 * last revised, which the statement's own closing section prints. Deriving it
 * from the render date would silently re-date an unchanged document on every
 * deploy.
 *
 * Layout is /privacy's — the 820px column, the gap-10 section rhythm, the
 * header block, the local typography components below, legal.css and
 * SiteDisclosureFooter. Two deliberate divergences:
 *
 *   1. `Section` takes no number. /privacy and /terms are numbered documents
 *      and their sections print "1.", "2."; this statement's sections are not
 *      numbered in the approved text, and numbering them here would be adding
 *      text to a legal document.
 *
 *   2. No turquoise. /privacy paints its "חזרה לעמוד הבית" link
 *      --color-tg-primary and hovers the other links to it. html.light does
 *      not override that token, so #00d2d2 stays over a #ffffff page and
 *      lands near 1.7:1 — the known light-theme token failure (REF-96). Every
 *      other page inherits it; this one must not, because it is the page that
 *      claims AA. Links here carry --color-tg-text and hover to
 *      --color-tg-text-2: 18.1:1 / 8.9:1 in light, 14.9:1 / 16.1:1 in dark.
 *      They are underlined, so they are not distinguished by colour alone
 *      either. When REF-96 lands this page is already correct and does not
 *      need revisiting.
 *
 * This page also has to BE what it describes, not merely assert it: one h1,
 * h2 per section, h3 for the four subsections of "התאמות הנגישות שבוצעו
 * באתר" and nothing skipped; a real <table> with a <caption> and scope="col"
 * on every <th>; the content landmark the skip link targets.
 */
export const metadata: Metadata = {
  title: 'הצהרת נגישות — Reflect',
  description:
    'הצהרת הנגישות של Reflect — ההתאמות שבוצעו באתר ובאפליקציה, הדפדפנים שבהם נבדקה הנגישות, המגבלות הידועות ודרכי הפנייה בנושא נגישות.',
  alternates: { canonical: '/accessibility' },
};

const LAST_UPDATED = '11.10.2026';
const WRITTEN = '15.08.2026';
const CONTACT_EMAIL = 'hello@reflecttrading.app';
const CONTACT_PHONE = '050-2255903';

/* The footnote under the browser table, and the id the marked row points at.
   There is no footnote convention in the repo to follow — this is the first
   one — so it is the plainest thing that works: the note is a <p> directly
   under the table, and the cell carrying the ¹ references it with
   aria-describedby, so a screen reader reads the note as part of that cell
   instead of announcing a stray superscript.

   Deliberately not <a href="#…"><sup>¹</sup></a>: the visible text of that
   link is a superscript glyph, which gives it either a useless accessible
   name or (with aria-label) a name that no longer contains its own visible
   label, and WCAG 2.5.3 is the wrong thing to break on this page. */
const BROWSER_NOTE_ID = 'browser-support-note';

type BrowserRow = {
  browser: string;
  /** null renders the em dash — iOS Safari has no version of its own here. */
  version: string | null;
  os: string;
  result: string;
  footnote?: boolean;
};

const BROWSER_ROWS: BrowserRow[] = [
  { browser: 'Safari', version: '18.6', os: 'macOS Ventura', result: 'תקין בכל הזרימות' },
  { browser: 'Safari', version: null, os: 'iOS 26.6.1 (iPhone 15)', result: 'תקין בכל הזרימות' },
  {
    browser: 'Google Chrome',
    version: '154.0.8037.95',
    os: 'macOS Ventura',
    result: 'תקין בכל הזרימות',
  },
  {
    browser: 'Mozilla Firefox',
    version: '157.0',
    os: 'macOS Ventura',
    result: 'תקין בכל הזרימות',
  },
  {
    browser: 'Google Chrome',
    version: '154.0.8037.126',
    os: 'Android 16',
    result: 'תקין — נחיתה והתחברות',
    footnote: true,
  },
  {
    browser: 'Google Chrome',
    version: '154.0.8037.98',
    os: 'Windows',
    result: 'תקין בכל הזרימות',
  },
];

export default function AccessibilityPage() {
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
            הצהרת נגישות
          </h1>
          <p className="text-xs font-normal" style={{ color: 'var(--color-tg-disclosure)' }}>
            עודכן לאחרונה: <Ltr>{LAST_UPDATED}</Ltr>
          </p>
        </header>

        <Section title="מחויבות לנגישות">
          <P>
            אנו ב-Reflect רואים חשיבות רבה במתן שירות שוויוני לכלל הגולשים, לרבות אנשים עם מוגבלות.
            אנו פועלים כדי שהאתר יהיה נוח, זמין ונגיש לשימוש, ומשקיעים משאבים בשיפור מתמשך של
            נגישותו.
          </P>
          <P>
            האתר הונגש בהתאם לתקן הישראלי ת&quot;י 5568 &quot;קווים מנחים לנגישות תכני
            אינטרנט&quot;, המבוסס על הנחיות <Ltr>WCAG 2.0</Ltr> של ארגון <Ltr>W3C</Ltr>, ברמת
            נגישות AA.
          </P>
        </Section>

        <Section title="התאמות הנגישות שבוצעו באתר">
          <H3>כלי נגישות ייעודי</H3>
          <P>
            באתר מוטמע כלי נגישות שפותח על ידינו, ולא תוסף חיצוני, הנפתח באמצעות סמל הנגישות המופיע
            בפינה השמאלית-תחתונה בכל עמודי האתר. הכלי מאפשר את ההתאמות הבאות:
          </P>
          <UL>
            <li>הגדלת טקסט — שינוי גודל הטקסט באתר במדרגות, תוך שמירה על מבנה העמוד</li>
            <li>מצבי ניגודיות — שלוש אפשרויות תצוגה לבחירת המשתמש</li>
            <li>גווני אפור — הפחתת רוויית הצבע בעמוד</li>
            <li>הדגשת קישורים — סימון ויזואלי מובלט של כל הקישורים</li>
            <li>גופן קריא — החלפת הגופן בגופן בעל קריאות גבוהה</li>
            <li>סמן מוגדל — הגדלת סמן העכבר</li>
            <li>עצירת אנימציות — עצירת התנועה והאנימציות באתר</li>
          </UL>
          <P>בחירות המשתמש נשמרות בדפדפן ונטענות מחדש בכניסות הבאות.</P>

          <H3>ניווט מקלדת ומבנה</H3>
          <UL>
            <li>
              ניווט מקלדת מלא — ניתן לנווט בכל האתר ובכל עמודי האפליקציה באמצעות מקש <Ltr>Tab</Ltr>
              , להפעיל קישורים וכפתורים באמצעות <Ltr>Enter</Ltr> או מקש הרווח, ולסגור חלונות באמצעות{' '}
              <Ltr>Esc</Ltr>
            </li>
            <li>
              קישור דילוג לתוכן — בכל עמודי האתר והאפליקציה, המופיע בלחיצת <Ltr>Tab</Ltr> ראשונה
              ומאפשר לדלג על תפריט הניווט
            </li>
            <li>מיקוד נראה — האלמנט הפעיל מסומן ויזואלית בעת ניווט מקלדת</li>
            <li>אזור תוכן ראשי מסומן — בכל עמודי האתר והאפליקציה</li>
            <li>
              חלונות קופצים — כל החלונות הקופצים באתר מוגדרים סמנטית כדיאלוג, כולל לכידת מיקוד
              מעגלית, סגירה ב-<Ltr>Esc</Ltr> והחזרת המיקוד לנקודת המוצא
            </li>
            <li>
              שורות טבלה ורשימה — שורות ביומן העסקאות, בדשבורד וביומן האישי ניתנות להפעלה באמצעות
              מקלדת, ולא בעכבר בלבד
            </li>
            <li>סדר מיקוד תקין — סדר המעבר בין רכיבי העמוד עוקב אחר סדר הקריאה</li>
          </UL>

          <H3>תוכן וסמנטיקה</H3>
          <UL>
            <li>היררכיית כותרות תקינה וסימון תפקידי אזורים בעמוד</li>
            <li>
              שמות נגישים לפקדים — כל הכפתורים, הקישורים וסמלי הניווט נושאים שם שניתן להקראה, לרבות
              תפריט הניווט הצדי במצב מכווץ
            </li>
            <li>
              שדות טופס מתויגים — כל שדות הטפסים באתר ובאפליקציה משויכים לתווית, וכוללים הסבר מקושר
              היכן שנדרש
            </li>
            <li>
              טקסט חלופי — סמלים עיצוביים מוסתרים מקוראי מסך, וסמלים נושאי מידע נושאים שם מתאים
            </li>
            <li>טבלאות — טבלאות הנתונים מסומנות סמנטית, כולל סימון כותרות עמודה וכותרת טבלה</li>
            <li>
              מידע שאינו מועבר בצבע בלבד — היכן שמוצג מצב או תוצאה, המשמעות נמסרת בטקסט ולא בצבע או
              בסמל בלבד
            </li>
            <li>תמיכה בעברית ובכיוון ימין-לשמאל בכל רכיבי האתר והאפליקציה</li>
          </UL>

          <H3>כיבוד העדפות מערכת ההפעלה והדפדפן</H3>
          <UL>
            <li>
              צמצום תנועה — משתמש שהגדיר במערכת ההפעלה העדפה לצמצום תנועה (
              <Ltr>prefers-reduced-motion</Ltr>) יקבל אתר ללא אנימציות וללא גלילה חלקה, גם ללא
              שימוש בכלי הנגישות
            </li>
            <li>
              גודל טקסט — משתמש שהגדיר בדפדפן שלו גודל טקסט מוגדל יקבל אתר המותאם להעדפה זו, וכלי
              הנגישות מגדיל יחסית להעדפה זו ולא במקומה
            </li>
            <li>
              תצוגה ללא <Ltr>JavaScript</Ltr> — תוכן דף הנחיתה מוצג גם כאשר <Ltr>JavaScript</Ltr>{' '}
              אינו זמין או נכשל בטעינה
            </li>
          </UL>
        </Section>

        <Section title="דפדפנים שבהם נבדקה הנגישות">
          <P>
            האתר והאפליקציה נבדקו בדפדפנים הבאים. הבדיקה כללה את הזרימות המרכזיות: נחיתה, הרשמה,
            התחברות, איפוס סיסמה, רישום עסקה, דשבורד והגדרות.
          </P>

          <div className="legal-table-scroll">
            <table className="legal-table">
              {/* Visually hidden — the section heading above already names the
                  table, so a visible caption would print it twice. Same call
                  /privacy and PerformanceTable make. */}
              <caption className="sr-only">
                הדפדפנים, הגרסאות ומערכות ההפעלה שבהם נבדקה הנגישות, ותוצאת הבדיקה בכל אחד מהם
              </caption>
              <thead>
                <tr>
                  <th scope="col">דפדפן</th>
                  <th scope="col">גרסה</th>
                  <th scope="col">מערכת הפעלה</th>
                  <th scope="col">תוצאה</th>
                </tr>
              </thead>
              <tbody>
                {BROWSER_ROWS.map((row) => (
                  <tr key={`${row.browser} ${row.os} ${row.version ?? ''}`}>
                    <td>
                      <LtrPhrase>{row.browser}</LtrPhrase>
                    </td>
                    <td>{row.version === null ? '—' : <Ltr>{row.version}</Ltr>}</td>
                    <td>
                      <LtrPhrase>{row.os}</LtrPhrase>
                    </td>
                    {/* aria-describedby only on the row that carries the
                        marker, so the note is read with that cell and nowhere
                        else. */}
                    <td aria-describedby={row.footnote ? BROWSER_NOTE_ID : undefined}>
                      {row.result}
                      {row.footnote ? <sup>¹</sup> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p
            id={BROWSER_NOTE_ID}
            className="text-sm leading-relaxed"
            style={{ color: 'var(--color-tg-muted)' }}
          >
            ¹ במכשיר האנדרואיד נבדקו בנפרד נחיתה והתחברות. שאר הזרימות נבדקו במנוע הדפדפן הזהה
            בגרסת שולחן העבודה.
          </p>
        </Section>

        <Section title="התאמות נגישות בשירות הפיזי">
          <P>
            Reflect הוא שירות מקוון בלבד. אין לעסק מקום המקבל קהל, ולפיכך לא נדרשות ולא בוצעו
            התאמות נגישות במבנה פיזי.
          </P>
        </Section>

        <Section title="נגישות באירועים">
          <P>העסק אינו מקיים אירועים פתוחים לקהל.</P>
        </Section>

        <Section title="דפדפנים נתמכים">
          <P>
            האפליקציה בנויה על טכנולוגיות המחייבות דפדפן עדכון יחסית. להלן הדפדפנים שבהם האפליקציה
            אינה פועלת במלואה:
          </P>
          <UL>
            <li>
              <Ltr>Safari</Ltr> בגרסה מוקדמת מ-<Ltr>16.4</Ltr> — דף הנחיתה מוצג כראוי, אך הכניסה
              לאפליקציה והמסכים שבתוכה אינם נטענים. מומלץ לעדכן את <Ltr>Safari</Ltr> או להשתמש
              בדפדפן אחר.
            </li>
            <li>
              הדפדפן הפנימי של אפליקציית <Ltr>Google</Ltr> באנדרואיד — ההתחברות אינה מצליחה. באותו
              מכשיר, פתיחת האתר ב-<Ltr>Chrome</Ltr> פועלת כראוי. אנו פועלים לתיקון.
            </li>
          </UL>
        </Section>

        <Section title="מגבלות ידועות">
          <P>
            חרף מאמצינו, ייתכנו חלקים באתר שטרם הונגשו במלואם. אנו פועלים לשיפורם באופן שוטף.
            המגבלות הידועות לנו נכון למועד עדכון הצהרה זו:
          </P>
          <UL>
            <li>
              ניגודיות צבעים בתצוגה הבהירה — בתצוגה הבהירה של האפליקציה, צבעי ההדגשה של המותג אינם
              עומדים ביחס הניגודיות הנדרש ברמה AA כאשר הם משמשים כטקסט. הדבר נוגע לערכי רווח והפסד
              ולחלק מסמלי ההדגשה והתגיות. התצוגה הכהה עומדת בדרישה ברוב המסכים, וכלי הנגישות מאפשר
              מצבי ניגודיות חלופיים. אנו פועלים לתיקון עד סוף הרבעון הראשון של 2027.
            </li>
            <li>
              גרפים ותרשימים — התרשימים בדשבורד אינם כוללים כיום חלופה טקסטואלית מלאה לנתונים
              המוצגים בהם. אנו פועלים לתיקון עד סוף ינואר 2027.
            </li>
            <li>
              גלילת רקע בחלונות קופצים — ברוב החלונות הקופצים באתר ניתן עדיין לגלול את תוכן הרקע.
              אנו פועלים לתיקון עד סוף נובמבר 2026.
            </li>
            <li>
              תוכן צד שלישי — האתר מציג גרפים המסופקים על ידי שירות חיצוני (<Ltr>TradingView</Ltr>
              ). רכיבים אלה אינם בשליטתנו ורמת הנגישות שלהם נקבעת על ידי הספק. הגרף נטען רק לאחר
              בחירה מפורשת של המשתמש.
            </li>
            <li>
              סמן מוגדל — התאמה זו רלוונטית למכשירים המופעלים באמצעות עכבר בלבד, ואין לה השפעה
              במכשירי מגע.
            </li>
          </UL>
        </Section>

        <Section title="פטורים והקלות">
          <P>לא ניתנו לעסק פטורים או הקלות מחובות הנגישות.</P>
        </Section>

        <Section title="פניות בנושא נגישות">
          <P>נתקלת בבעיית נגישות באתר? נשמח שתעדכן אותנו, ונפעל לתקן אותה בהקדם.</P>
          <UL>
            <li>
              דואר אלקטרוני: <ContactEmail />
            </li>
            <li>
              טלפון: <ContactPhone />
            </li>
            <li>זמן מענה משוער: עד 3 ימי עסקים. אין מענה בימי שישי, שבת וחגי ישראל.</li>
          </UL>
        </Section>

        <Section title="עדכון ההצהרה">
          <UL>
            <li>
              תאריך כתיבת ההצהרה: <Ltr>{WRITTEN}</Ltr>
            </li>
            <li>
              תאריך העדכון האחרון: <Ltr>{LAST_UPDATED}</Ltr>
            </li>
          </UL>
          <P>הצהרה זו תעודכן בעקבות שינויים מהותיים באתר או בהתאמות הנגישות שבו.</P>
        </Section>

        <div className="flex flex-wrap gap-x-6 gap-y-2 pt-2">
          <PageLink href="/" strong>
            חזרה לעמוד הבית
          </PageLink>
          <PageLink href="/terms">תנאי שימוש</PageLink>
          <PageLink href="/privacy">מדיניות פרטיות</PageLink>
          <PageLink href="/risk-disclosure">גילוי סיכון</PageLink>
        </div>
      </main>
      <SiteDisclosureFooter />
    </>
  );
}

/* ── Local typography ──────────────────────────────────────────────
   /privacy's and /terms', minus the section number — see the note at the top
   of the file. Kept as a local copy for the same reason those two keep one:
   they are a handful of one-line style wrappers, and a shared
   legal/typography.tsx would couple three documents' visual scale together at
   exactly the point where one might later need to diverge. */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold" style={{ color: 'var(--color-tg-text-2)' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function H3({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-lg font-bold mt-3" style={{ color: 'var(--color-tg-text-2)' }}>
      {children}
    </h3>
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

/* ── LTR runs ──────────────────────────────────────────────────────
   This document carries far more Latin than /privacy or /terms — six browser
   versions, four OS strings, a CSS media-feature name, a standard and a
   standards body — so it wraps more of them than the note in legal.css
   advises. That note is about ordinary prose, where a lone Latin word
   resolves correctly on its own; here the runs sit in table cells and in
   bracketed or hyphenated positions where they do not, and the few that would
   resolve anyway are wrapped for consistency with the ones beside them.

   `Ltr` is `.legal-ltr` — inline-block, so a single token cannot be split off
   from the rest of its line. Right for a version, an address, a phone number
   or a one-word name.

   `LtrPhrase` is the same isolation without the inline-block, and the table's
   multi-word cells use it: an inline-block is shrink-to-fit, so at phone width
   "macOS Ventura" wraps to the box's own left edge while the Hebrew column
   header stays at the right, and the column stops lining up. It buys no width
   either way — an inline-block wraps internally too, and the table measures
   412px at 390px of viewport in both forms. */
function Ltr({ children }: { children: ReactNode }) {
  return (
    <span dir="ltr" className="legal-ltr">
      {children}
    </span>
  );
}

function LtrPhrase({ children }: { children: ReactNode }) {
  return (
    <span dir="ltr" className="legal-ltr-phrase">
      {children}
    </span>
  );
}

/* Isolated because the address is bounded by neutrals (@ and .) — inside an
   RTL line those take the paragraph's direction and drag the address apart.
   Same for the phone number's hyphens. */
function ContactEmail() {
  return (
    <a
      href={`mailto:${CONTACT_EMAIL}`}
      dir="ltr"
      className="legal-ltr underline underline-offset-2 transition-colors text-inherit hover:text-tg-text-2"
    >
      {CONTACT_EMAIL}
    </a>
  );
}

function ContactPhone() {
  return (
    <a
      href={`tel:${CONTACT_PHONE}`}
      dir="ltr"
      className="legal-ltr underline underline-offset-2 transition-colors text-inherit hover:text-tg-text-2"
    >
      {CONTACT_PHONE}
    </a>
  );
}

/* Not /privacy's `text-tg-primary` / `hover:text-tg-primary` — see divergence
   2 at the top of the file.

   Colour as a utility rather than an inline style, which is also why the two
   contact links above dropped theirs: an inline `color` outranks every class,
   so a `hover:text-*` sitting beside one never applies. */
function PageLink({
  href,
  strong = false,
  children,
}: {
  href: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`underline underline-offset-2 transition-colors text-tg-text hover:text-tg-text-2 ${
        strong ? 'font-semibold' : ''
      }`}
    >
      {children}
    </Link>
  );
}
