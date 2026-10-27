/**
 * Footer compliance-copy regression suite.
 *
 * The NinjaTrader Vendor Professional and Compliance Guidelines (rev 2.11.2025)
 * require three pieces of prescribed wording to be *visible* on every page:
 * the risk disclosure in English, its approved Hebrew translation beside it,
 * and the trademark attribution. SiteDisclosureFooter is the only thing that
 * renders on every route, so it is the only thing that satisfies that.
 *
 * This has already been broken once and found by an outside audit rather than
 * by us — finding F4, commit 36cfbe9: the English risk paragraph rendered on
 * /risk-disclosure and nowhere else, because an earlier revision dropped it
 * from the footer to save vertical space. The two notes in disclosureText.ts
 * and FooterDisclosures.tsx say not to do it again; this script is what makes
 * that enforceable instead of advisory.
 *
 * It renders the footer rather than sweeping served HTML, so it needs no
 * running server and no build, and can therefore run in the same breath as
 * tsc. That does mean it proves the component and not the wiring, so the
 * mount check at the end covers the routing half. A served-HTML sweep is
 * still the stronger check of the two and is worth running by hand when the
 * layouts move — /demo/* reaches the real app shell without auth, which is
 * how the F4 fix was verified (1/18 -> 18/18).
 *
 * Usage: npx tsx scripts/footer-copy-check.tsx
 * Exits non-zero if any prescribed string is missing, altered, or rendered in
 * a way that fails the guidelines' presentation rule.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteDisclosureFooter } from '../src/components/legal/SiteDisclosureFooter';
import {
  NINJATRADER_ATTRIBUTION,
  RISK_DISCLOSURE_EN,
  RISK_DISCLOSURE_HE,
} from '../src/components/legal/disclosureText';
import { DISCLOSURE_TEXT_CLASS } from '../src/components/legal/disclosureStyle';

/**
 * Every file that mounts the footer. Losing one of these silently un-covers a
 * whole route group, which is the shape the F4 regression actually had.
 */
const MOUNTS = [
  'src/components/layout/AppShell.tsx',
  'src/app/(auth)/layout.tsx',
  'src/app/(protected)/layout.tsx',
  'src/app/terms/page.tsx',
  'src/app/privacy/page.tsx',
  'src/app/accessibility/page.tsx',
  'src/app/phone-showcase/page.tsx',
  // REF-125. Both halves of the public share route. It sits outside `(app)`,
  // `(auth)` and `(protected)`, so it inherits no footer from any layout and
  // each page mounts one directly. The not-found boundary is listed too: a
  // revoked link is a page a stranger reaches and reads, and the disclosures
  // are required on every page rather than on every successful one.
  'src/app/share/[token]/page.tsx',
  'src/app/share/[token]/not-found.tsx',
];

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

const html = renderToStaticMarkup(<SiteDisclosureFooter />);

/**
 * The prescribed strings contain characters React escapes on the way out —
 * the apostrophe in "ones'", the double quote in מט"ח, the ® in the
 * attribution. Compare against decoded text, or every assertion fails for a
 * reason that has nothing to do with compliance.
 */
function renderedText(markup: string): string {
  return markup
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const text = renderedText(html);

// ── 1. The prescribed wording, verbatim ────────────────────────────────────
const REQUIRED: Array<[string, string]> = [
  ['risk disclosure (Hebrew, approved translation)', RISK_DISCLOSURE_HE],
  ['risk disclosure (English, prescribed wording)', RISK_DISCLOSURE_EN],
  ['NinjaTrader trademark attribution', NINJATRADER_ATTRIBUTION],
];

for (const [name, required] of REQUIRED) {
  if (!text.includes(required.replace(/\s+/g, ' ').trim())) {
    fail(`${name} is not present verbatim in the rendered footer.`);
  }
}

// Both languages or neither — the Hebrew is the approved translation and
// travels with the English, it does not stand in for it.
const hasHe = text.includes(RISK_DISCLOSURE_HE.replace(/\s+/g, ' ').trim());
const hasEn = text.includes(RISK_DISCLOSURE_EN.replace(/\s+/g, ' ').trim());
if (hasHe !== hasEn) {
  fail(
    `the risk disclosure renders in one language only (Hebrew: ${hasHe}, English: ${hasEn}). ` +
      'Both must render together — this is exactly audit finding F4.',
  );
}

// ── 2. The presentation rule that comes with the wording ───────────────────
// "Rendered at the same (or similar) style and size as the primary page
// content and easily visible." Two concrete failure modes are checked, both
// of which keep the string in the DOM and so would pass a text-only test.

// A <details> leaves the text in the markup but not on the screen.
if (/<details[\s>]/i.test(html)) {
  fail('the disclosures are inside a <details> element — collapsed text is not "easily visible".');
}

if (/display:\s*none|visibility:\s*hidden/i.test(html)) {
  fail('part of the footer is hidden by inline style; the disclosures must be visible on every page.');
}

// A `hidden` / `md:hidden` utility class, or a bare `hidden` attribute. Matched
// on exact class tokens rather than as a substring: `overflow-hidden` is fine,
// and `aria-hidden` is *correct* on the decorative link separator — a looser
// test flagged both and said nothing about visibility.
const classTokens = [...html.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/));
const hidingClass = classTokens.find(t => t === 'hidden' || t.endsWith(':hidden'));
if (hidingClass) {
  fail(`the footer carries a "${hidingClass}" class — the disclosures must be visible at every breakpoint.`);
}

if (/<[^>]*(?<!aria-)\bhidden(?=[\s=>])/.test(html)) {
  fail('an element in the footer carries the `hidden` attribute.');
}

// disclosureStyle.ts owns the legibility floor and documents why text-xs (14px
// here, not 12 — globals.css bumps the scale) is the smallest permitted size.
// Pinning the class means a hand-rolled smaller size in the footer fails here
// rather than shipping.
if (!html.includes(DISCLOSURE_TEXT_CLASS)) {
  fail(
    `the disclosure paragraphs do not carry DISCLOSURE_TEXT_CLASS ("${DISCLOSURE_TEXT_CLASS}"), ` +
      'which is the documented legibility floor for this text.',
  );
}

for (const smaller of ['text-[11px]', 'text-[12px]', 'text-[13px]', 'text-2xs']) {
  if (html.includes(smaller)) {
    fail(`the footer renders text at ${smaller}, below the documented legibility floor.`);
  }
}

// ── 3. A link may supplement the text, never replace it ────────────────────
if (!html.includes('href="/risk-disclosure"')) {
  fail('the supplementary link to /risk-disclosure is missing from the footer.');
}

// ── 4. The footer is still mounted everywhere it has to be ─────────────────
for (const file of MOUNTS) {
  let source: string;
  try {
    source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  } catch {
    fail(`${file} could not be read — if the route moved, update MOUNTS in this script.`);
    continue;
  }
  if (!source.includes('<SiteDisclosureFooter')) {
    fail(`${file} no longer renders <SiteDisclosureFooter />, so its routes carry no disclosures.`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`footer-copy-check: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    '\nThese strings are prescribed by the NinjaTrader vendor guidelines. See the notes in\n' +
      'src/components/legal/disclosureText.ts before changing this test to match the code.',
  );
  process.exit(1);
}

console.log('footer-copy-check: ok');
console.log(`  ${REQUIRED.length} prescribed strings verbatim, both risk languages present`);
console.log(`  presentation floor ${DISCLOSURE_TEXT_CLASS}, not collapsed or hidden`);
console.log(`  mounted in ${MOUNTS.length} files`);
