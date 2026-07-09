// Canned /api responses for demo mode, served by the fetch guard so no
// request ever leaves the browser. Auto-firing widgets (weekly summary,
// coach insights, patterns) and the trade debrief get believable content;
// every other API call is a user-initiated action → signup upsell + 403.
import {
  DEMO_DEBRIEF_RESULT,
  DEMO_COACH_INSIGHTS,
  DEMO_PATTERNS,
  demoWeeklySummaryResponse,
} from './fixtures';
import { triggerDemoUpsell } from './demoDb';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function demoApiResponse(pathname: string): Response {
  if (pathname.startsWith('/api/weekly-summary')) return json(demoWeeklySummaryResponse());
  if (pathname.startsWith('/api/ai-debrief'))     return json(DEMO_DEBRIEF_RESULT);
  if (pathname.startsWith('/api/ai-coach'))       return json({ insights: DEMO_COACH_INSIGHTS });
  if (pathname.startsWith('/api/ai-patterns'))    return json({ patterns: DEMO_PATTERNS });
  triggerDemoUpsell();
  return json({ error: 'DEMO_MODE' }, 403);
}
