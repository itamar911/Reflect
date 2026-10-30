// Canned /api responses for demo mode, served by the fetch guard so no
// request ever leaves the browser. Auto-firing widgets (weekly summary,
// coach insights, patterns) and the trade debrief get believable content;
// every other API call is a user-initiated action → signup upsell + 403.
import {
  DEMO_DEBRIEF_RESULT,
  DEMO_COACH_INSIGHTS,
  DEMO_PATTERNS,
  demoShareTodayResponse,
  demoWeeklySummaryResponse,
} from './fixtures';
import { triggerDemoUpsell } from './demoDb';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * `method` separates the two kinds of demo /api call.
 *
 * A GET is a widget reading on mount, and the visitor did not ask for it — so
 * it gets canned content, and anything uncanned gets a quiet 403 with NO
 * upsell. A write is the visitor pressing something, which is exactly when the
 * upsell belongs.
 *
 * The distinction was added for `/api/share/today`: ShareDayButton GETs it on
 * every dashboard mount, so the old method-blind version opened /demo/dashboard
 * with the signup modal already over the page.
 */
export function demoApiResponse(pathname: string, method = 'GET'): Response {
  if (pathname.startsWith('/api/weekly-summary')) return json(demoWeeklySummaryResponse());
  if (pathname.startsWith('/api/ai-debrief'))     return json(DEMO_DEBRIEF_RESULT);
  if (pathname.startsWith('/api/ai-coach'))       return json({ insights: DEMO_COACH_INSIGHTS });
  if (pathname.startsWith('/api/ai-patterns'))    return json({ patterns: DEMO_PATTERNS });
  // Today's card as the dialog opens onto it: a real preview, and no link yet,
  // so the demo shows "צור קישור" rather than somebody else's live token.
  // Minting one is a WRITE and falls through to the upsell below, which is the
  // same answer every other demo write gives.
  if (pathname.startsWith('/api/share/today') && method === 'GET') {
    const today = demoShareTodayResponse();
    // THE PROBE IS A DIFFERENT SHAPE and the demo answers it as the real route
    // does (REF-125 follow-up item 1.1): the dashboard asks `?probe=1` on
    // mount and gets "deployed, and no link minted yet", and only the dialog
    // asks for the payload with the preview in it. `pathname` here is the raw
    // request string, query included — see fetchGuard.
    if (pathname.includes('probe=1')) {
      return json({ available: today.available, day: today.day, exists: today.shares.length > 0 });
    }
    return json(today);
  }

  if (method === 'GET') return json({ error: 'DEMO_MODE' }, 403);
  triggerDemoUpsell();
  return json({ error: 'DEMO_MODE' }, 403);
}
