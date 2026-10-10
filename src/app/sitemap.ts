import type { MetadataRoute } from 'next';

// The only five routes a crawler should ever index. Everything else is behind
// auth, or is noindexed at the response level (/demo/* via the X-Robots-Tag in
// proxy.ts, /phone-showcase via its own robots export).
//
// /accessibility is here with the other three legal pages for the same reason
// they are: the statement is only useful if it can be found, and a crawler
// finding it is part of that.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    { url: 'https://reflecttrading.app/',        lastModified: now, changeFrequency: 'weekly',  priority: 1 },
    { url: 'https://reflecttrading.app/terms',   lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: 'https://reflecttrading.app/privacy', lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: 'https://reflecttrading.app/risk-disclosure', lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: 'https://reflecttrading.app/accessibility',   lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
