/**
 * Translated-page regression suite.
 *
 * Browser translators rewrite every text node into nested <font> wrappers.
 * React then throws on insertBefore/removeChild when it updates a position
 * whose recorded sibling has been replaced, and with no error boundary that
 * blanks the page. See git history for the four sites this caught:
 * HeroMock, RulesMock, Button, SetupsClient.
 *
 * Fidelity rules, each one learned from a bug that slipped past an earlier
 * version of this harness:
 *   - translate from a MutationObserver, not just once: intersection-gated
 *     components mount mid-scroll and only crash once their timers re-render
 *   - scroll the whole page, down AND back up
 *   - never translate inside <svg>: real translators don't, and a harness that
 *     did reported a false clean on the untranslated radar labels
 *   - descend into same-origin iframes: the landing page embeds the whole app
 *     in one, so it ran unverified under every earlier "all routes pass"
 *
 * It also carries one check that is not about translation at all — the share
 * card's Open Graph tags (`checkShareUnfurl` at the foot of this file). It
 * lives here because this is the suite that already serves a build and already
 * holds the /demo share route, and splitting it out would mean a second
 * harness booting a second server to fetch two URLs.
 *
 * Usage: node scripts/translation-check.mjs [baseUrl]
 * Exits non-zero if any page crashes, the embedded demo fails to render, or the
 * share page's unfurl tags regress.
 */
import playwright from 'playwright';

const { chromium } = playwright;

const BASE = process.argv[2] || process.env.BASE || 'http://localhost:3000';

/**
 * REF-125. The public share card, through /demo so it renders from fixtures
 * rather than needing a live token in a real database.
 *
 * THE TOKEN MUST STAY IN STEP WITH `DEMO_SHARE_TOKEN` in
 * src/lib/demo/fixtures.ts, and it is a literal here because this script is
 * plain node and cannot import TypeScript. scripts/share-leak-check.ts §8
 * asserts the two match — without that, drifting them makes this route visit
 * the not-found page, find no error boundary, and pass green while testing
 * nothing. The same is true if '/share' ever leaves isMarketingRoute in
 * src/proxy.ts, which that suite also checks.
 */
const SHARE_ROUTE = '/demo/share/demoshare0000000000000000demo';

const ROUTES = [
  '/', '/terms', '/privacy', '/risk-disclosure', '/login', '/signup',
  '/demo/dashboard', '/demo/trades', '/demo/stats', '/demo/journal',
  '/demo/setups', '/demo/notebook', '/demo/coach', '/demo/rules', '/demo/strategies',
  SHARE_ROUTE,
];

// The error boundary's heading (src/app/error.tsx). Its presence means a
// render threw and the page degraded instead of showing content.
const BOUNDARY_TEXT = 'אירעה שגיאה בטעינת העמוד';

/** Injected into a document to mimic a translator: <font> wrappers, never SVG. */
function installTranslator() {
  const wrap = (node) => {
    const p = node.parentNode;
    if (!p) return false;
    const t = p.nodeName;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEXTAREA') return false;
    if (t === 'FONT' && p.dataset && p.dataset.tr === '1') return false;
    for (let a = p; a; a = a.parentNode) {
      if (a.nodeName && a.nodeName.toLowerCase() === 'svg') return false;
    }
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    const outer = document.createElement('font');
    outer.style.verticalAlign = 'inherit';
    const inner = document.createElement('font');
    inner.style.verticalAlign = 'inherit';
    inner.dataset.tr = '1';
    inner.textContent = 'EN:' + node.nodeValue;
    outer.appendChild(inner);
    try { p.replaceChild(outer, node); } catch { return false; }
    return true;
  };
  const sweep = (root) => {
    if (!root) return 0;
    if (root.nodeType === 3) return wrap(root) ? 1 : 0;
    if (root.nodeType !== 1) return 0;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = w.nextNode())) nodes.push(n);
    let c = 0;
    for (const x of nodes) if (wrap(x)) c++;
    return c;
  };
  window.__trCount = sweep(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) for (const added of m.addedNodes) window.__trCount += sweep(added);
  }).observe(document.body, { childList: true, subtree: true });
}

/** Counts Hebrew vs Latin text nodes, plus translator wrappers, in a document. */
function measureCoverage() {
  const HEB = /[֐-׿]/;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let heb = 0;
  let lat = 0;
  let n;
  while ((n = w.nextNode())) {
    const v = (n.nodeValue || '').trim();
    if (!v) continue;
    if (HEB.test(v)) heb++;
    else if (/[A-Za-z]{3}/.test(v)) lat++;
  }
  return { heb, lat, fonts: document.getElementsByTagName('font').length };
}

const isCrash = (m) => m.includes('insertBefore') || m.includes('removeChild');

function watch(page, sink) {
  page.on('pageerror', (e) => sink.push('[pageerror] ' + e.message.split('\n')[0].slice(0, 150)));
  page.on('console', (m) => {
    if (m.type() === 'error') sink.push('[console] ' + m.text().split('\n')[0].slice(0, 150));
  });
}

async function scrollThrough(page) {
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= h; y += 500) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(400);
  }
  for (let y = h; y >= 0; y -= 900) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(300);
  }
}

const failures = [];

async function checkRoute(browser, route) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  watch(page, errs);
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await page.evaluate(installTranslator);
  await scrollThrough(page);

  const dead = await page.evaluate((t) => document.body.innerText.includes(t), BOUNDARY_TEXT);
  const n = await page.evaluate(() => window.__trCount).catch(() => -1);
  const crashes = [...new Set(errs)].filter(isCrash);
  const bad = dead || crashes.length > 0;
  if (bad) failures.push(route);
  console.log(
    `${bad ? 'FAIL  ' : 'ok    '} ${route.padEnd(20)} translated=${n}` +
    (dead ? '  <<< error boundary rendered' : '')
  );
  crashes.slice(0, 2).forEach((c) => console.log('         ' + c));
  await ctx.close();
}

/**
 * The landing page's embedded demo: a same-origin <iframe> loading the real app
 * (/demo/dashboard?embed=1). No route check above touches it, so the whole app
 * ran unverified inside the landing page.
 *
 * Three things fail independently here:
 *   1. the frame rendering at all — on the translate.goog proxy it does not,
 *      because the relative src drops the _x_tr_* params and Google answers 400
 *      with its own "Can't translate this page" page inside the frame;
 *   2. translation coverage — no translator enters an iframe, so the embed
 *      stays Hebrew under a translated parent. Reported every run so it stays
 *      visible instead of silently passing;
 *   3. the app inside surviving translation, observable only by translating
 *      within the frame.
 */
async function checkEmbeddedDemo(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  const errs = [];
  watch(page, errs);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // The iframe is mounted by an IntersectionObserver with a 600px margin, so
  // the section has to be scrolled near before it exists at all.
  await page.evaluate(() => {
    const host = Array.from(document.querySelectorAll('section, div'))
      .find((s) => s.querySelector('iframe')) ||
      Array.from(document.querySelectorAll('section'))
        .find((s) => s.textContent.includes('דמו'));
    (host || document.body).scrollIntoView({ block: 'center' });
  });
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(400);
  }

  const handle = await page.waitForSelector('iframe', { timeout: 15000 }).catch(() => null);
  const frame = handle ? await handle.contentFrame() : null;
  if (!frame) {
    failures.push('landing embed (no iframe)');
    console.log('FAIL   landing embed       iframe never mounted');
    await ctx.close();
    return;
  }
  await page.waitForTimeout(5000);

  const rendered = await frame.evaluate(() => document.body.innerText.trim().length).catch(() => 0);
  if (rendered < 300) {
    failures.push('landing embed (blank or error frame)');
  }

  // Translate the parent only, the way a real translator would, then look
  // inside: fontWrappers should be 0, which is the whole problem.
  await page.evaluate(installTranslator);
  await page.waitForTimeout(1500);
  const cov = await frame.evaluate(measureCoverage).catch(() => ({ heb: -1, lat: -1, fonts: -1 }));

  // Now translate inside the frame to crash-check the app running in it.
  await frame.evaluate(installTranslator).catch(() => {});
  await page.waitForTimeout(1500);
  await frame.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(2500);
  await frame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(2500);

  const frameDead = await frame
    .evaluate((t) => document.body.innerText.includes(t), BOUNDARY_TEXT)
    .catch(() => false);
  const inFrame = await frame.evaluate(() => window.__trCount).catch(() => -1);
  const crashes = [...new Set(errs)].filter(isCrash);
  if (frameDead || crashes.length > 0) failures.push('landing embed (crash)');

  const bad = frameDead || crashes.length > 0 || rendered < 300;
  console.log(
    `${bad ? 'FAIL  ' : 'ok    '} landing embed       rendered=${rendered}ch translatedInFrame=${inFrame}` +
    (rendered < 300 ? '  <<< frame did not render' : '') +
    (frameDead ? '  <<< error boundary inside frame' : '')
  );
  console.log(
    `         reached by page translator: hebrew=${cov.heb} latin=${cov.lat} fontWrappers=${cov.fonts}` +
    (cov.fonts === 0 ? '  (0 is expected: translators do not enter iframes)' : '')
  );
  crashes.slice(0, 2).forEach((c) => console.log('         ' + c));
  await ctx.close();
}

/**
 * The share card's unfurl tags (REF-125 Stage 3, REF-128).
 *
 * NO BROWSER, AND THAT IS THE ASSERTION. Everything else in this file drives
 * Playwright; this one fetches raw HTML with `fetch` and regexes the markup,
 * because the property under test is that the tags are in the SERVER's
 * response. WhatsApp, facebookexternalhit and Telegram run no JavaScript, so a
 * head assembled client-side is a head they never see — and a Playwright
 * assertion would pass on exactly that broken page, since by the time it reads
 * the DOM React has hydrated and put the tags there. Reading the bytes off the
 * wire is the only version of this check that can fail for the right reason.
 *
 * WHY THESE SIX TAGS. Each is a way the preview degrades to a bare link rather
 * than erroring visibly: no og:image is no card; a RELATIVE og:image is the
 * classic form of that, since unfurlers do not resolve it against anything and
 * `metadataBase` in src/app/layout.tsx is the only reason ours ships absolute;
 * wrong dimensions get the card cropped to a thumbnail; a missing og:title
 * leaves the URL as its own headline.
 *
 * THE IMAGE IS FETCHED AT THE LOCAL PATH, NOT AT og:image's URL. og:image is
 * absolute against the hardcoded apex, so following it from a local run would
 * test production and pass green against a broken build (and a CI run would
 * silently depend on the internet). The absoluteness is asserted as a string;
 * the fetch goes to this run's own BASE.
 */
async function checkShareUnfurl() {
  const label = 'share unfurl tags';
  const problems = [];
  const bot = { 'user-agent': 'WhatsApp/2.23.20.0 A' };

  // No cookie jar: `fetch` sends none, which is the anonymous crawler's case —
  // the one src/proxy.ts has to let past the auth gate.
  const res = await fetch(BASE + SHARE_ROUTE, { headers: bot, redirect: 'manual' });
  const html = res.status === 200 ? await res.text() : '';
  if (res.status !== 200) problems.push(`page answered ${res.status} (unfurlers need a 200)`);

  // `<head>` only. A string that happens to appear in the page body, or in a
  // serialised RSC payload further down, is not a meta tag.
  const head = html.slice(0, html.indexOf('</head>') + 1);
  const meta = (property) => {
    const m = head.match(
      new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]*content="([^"]*)"`, 'i')
    ) || head.match(
      new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${property}"`, 'i')
    );
    return m === null ? null : m[1];
  };

  const ogImage = meta('og:image');
  if (ogImage === null) problems.push('no og:image in the server-rendered head');
  else if (!/^https:\/\/[^/]+\/.+/.test(ogImage)) {
    problems.push(`og:image is not an absolute https URL: ${ogImage}`);
  }

  const ogTitle = meta('og:title');
  if (ogTitle === null || ogTitle.trim() === '') problems.push('no og:title');

  if (meta('og:description') === null) problems.push('no og:description');
  if (meta('og:url') === null) problems.push('no og:url');
  if (meta('og:image:type') !== 'image/png') {
    problems.push(`og:image:type is ${meta('og:image:type')}, expected image/png`);
  }
  const dims = `${meta('og:image:width')}x${meta('og:image:height')}`;
  if (dims !== '1200x630') problems.push(`og:image dimensions are ${dims}, expected 1200x630`);

  // The route behind og:image, as the crawler reaches it: a bot UA, no
  // cookies, and no redirect followed — an auth bounce must fail here rather
  // than be quietly resolved into a 200 for the login page.
  const img = await fetch(`${BASE}${SHARE_ROUTE}/image`, { headers: bot, redirect: 'manual' });
  const bytes = img.status === 200 ? (await img.arrayBuffer()).byteLength : 0;
  const type = img.headers.get('content-type');
  if (img.status !== 200) problems.push(`image route answered ${img.status}`);
  else if (type !== 'image/png') problems.push(`image Content-Type is ${type}, expected image/png`);
  // WhatsApp's own ceiling, and the tightest of the platforms' limits.
  else if (bytes > 300 * 1024) problems.push(`image is ${Math.round(bytes / 1024)}KB, over 300KB`);

  if (problems.length) failures.push(label);
  console.log(
    `${problems.length ? 'FAIL  ' : 'ok    '} ${label.padEnd(20)} ` +
    `og:image=${ogImage === null ? 'missing' : ogImage.replace(/^https:\/\//, '')} ` +
    `png=${Math.round(bytes / 1024)}KB`
  );
  problems.forEach((p) => console.log('         ' + p));
}

const browser = await chromium.launch();
console.log(`translated-page suite against ${BASE}\n`);
for (const route of ROUTES) await checkRoute(browser, route);
console.log('');
await checkEmbeddedDemo(browser);
await browser.close();

console.log('');
await checkShareUnfurl();

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`passed: ${ROUTES.length} routes + embedded demo + share unfurl`);
