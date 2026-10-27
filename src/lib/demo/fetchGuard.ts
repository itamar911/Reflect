// Module-level window.fetch guard — imported by AppShell so it is installed
// during bundle evaluation, before any component effect can fire an /api call.
// The demo check runs per call (not at install time) so it stays correct
// across soft navigations into and out of /demo. Outside /demo every request
// passes straight through; inside /demo, /api/* is answered locally (canned
// content or upsell) and never reaches the network.

let installed = false;

if (typeof window !== 'undefined' && !installed) {
  installed = true;
  const realFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (window.location.pathname.startsWith('/demo')) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = url.startsWith('/') ? url : new URL(url, window.location.origin).pathname;
      if (pathname.startsWith('/api/')) {
        // The METHOD matters now: a demo READ that a widget fires on mount gets
        // canned content, while a WRITE the visitor initiated gets the upsell.
        // Without it, ShareDayButton's mount-time GET /api/share/today fell to
        // the upsell branch and threw the signup modal in front of every
        // /demo/dashboard load, unprompted.
        const method = (
          init?.method ?? (input instanceof Request ? input.method : 'GET')
        ).toUpperCase();
        return import('./demoApi').then(({ demoApiResponse }) =>
          demoApiResponse(pathname, method));
      }
    }
    return realFetch(input, init);
  };
}

export {};
