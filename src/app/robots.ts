import type { MetadataRoute } from 'next';

// Authed app shell and auth screens — nothing here is useful in an index, and
// the app routes all bounce an anonymous crawler to /login anyway.
//
// Deliberately NOT listed: /demo/* and /phone-showcase. Both already answer
// with noindex — /demo/* through the X-Robots-Tag header in proxy.ts, and
// /phone-showcase through its own robots metadata export. Disallowing them
// here would stop a crawler fetching them at all, and a crawler that never
// fetches the page never sees the noindex. Blocking the fetch is the weaker
// guarantee, not the stronger one.
const DISALLOW = [
  '/api/',
  '/dashboard',
  '/journal',
  '/trades',
  '/stats',
  '/strategies',
  '/setups',
  '/rules',
  '/coach',
  '/notebook',
  '/settings',
  '/feedback',
  '/onboarding',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: DISALLOW,
    },
    sitemap: 'https://reflecttrading.app/sitemap.xml',
  };
}
