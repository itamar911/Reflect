/**
 * Verbatim compliance copy required by the NinjaTrader Vendor Professional and
 * Compliance Guidelines (rev 2.11.2025).
 *
 * Every string in this file is prescribed wording. Do not paraphrase, shorten,
 * translate, or "tighten" any of it — including the punctuation and the
 * "ones'" in the English risk disclosure, which is how NinjaTrader writes it.
 * The Hebrew risk text is the approved translation and travels with the
 * English one; both must render together, never one alone.
 *
 * Presentation rule that comes with the wording: these must be rendered at the
 * same (or similar) style and size as the primary page content and be easily
 * visible. Small grey footer type does not satisfy the guideline, which is why
 * every component that renders them below uses body-size text in the primary
 * text colour rather than the muted token. Hyperlinks may supplement the text
 * but may never replace it.
 */

export const RISK_DISCLOSURE_HE =
  'מסחר בחוזים עתידיים ובמט"ח כרוך בסיכון משמעותי ואינו מתאים לכל משקיע. משקיע עלול לאבד את מלוא ההשקעה הראשונית ואף יותר ממנה. הון סיכון הוא כסף שניתן להפסיד מבלי לסכן את הביטחון הכלכלי או את אורח החיים. יש לסחור אך ורק בהון סיכון, ורק מי שברשותו הון סיכון מספק צריך לשקול מסחר. ביצועי עבר אינם בהכרח מעידים על תוצאות עתידיות.';

export const RISK_DISCLOSURE_EN =
  "Futures and forex trading contains substantial risk and is not for every investor. An investor could potentially lose all or more than the initial investment. Risk capital is money that can be lost without jeopardizing ones' financial security or life style. Only risk capital should be used for trading and only those with sufficient risk capital should consider trading. Past performance is not necessarily indicative of future results.";

/**
 * Required, in English only, on every page that mentions the NinjaTrader
 * platform. Explicitly not translated — the attribution is a trademark notice,
 * and NinjaTrader prescribes it in this language.
 */
export const NINJATRADER_ATTRIBUTION =
  'NinjaTrader® is a registered trademark of NinjaTrader Group, LLC. No NinjaTrader company has any affiliation with the owner, developer, or provider of the products or services described herein, or any interest, ownership or otherwise, in any such product or service, or endorses, recommends or approves any such product or service.';

/**
 * Goes on every visual that shows figures which are not a real trader's real
 * results. Under the guidelines unlabelled numbers read as hypothetical
 * performance, which carries a much heavier disclosure burden than simply
 * saying the picture is an illustration.
 */
export const ILLUSTRATIVE_LABEL = 'תצוגה להמחשה · נתונים לדוגמה';

/**
 * Required alongside testimonials, prominently displayed, whenever real ones
 * exist. Nothing renders these today — the testimonial section was removed
 * until real customer clips are available — but they are the wording to use
 * when it comes back. Paid testimonials must additionally be disclosed as paid.
 */
export const TESTIMONIAL_DISCLOSURE_EN =
  'Testimonials appearing on this website may not be representative of other clients or customers and is not a guarantee of future performance or success.';

export const TESTIMONIAL_DISCLOSURE_HE =
  'עדויות המופיעות באתר זה אינן בהכרח מייצגות את חווייתם של לקוחות אחרים, ואינן מהוות ערובה לביצועים או להצלחה עתידיים.';
