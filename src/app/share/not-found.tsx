/**
 * What a dead share link says (REF-125 Stage 2 item 4).
 *
 * THE FIRST `not-found.tsx` IN THIS CODEBASE. The repo's prevailing convention
 * for bad input is a REDIRECT — src/proxy.ts:30-32 and
 * app/auth/confirm/route.ts:39-41 — and that convention is deliberately not
 * followed here. A redirect to /login or /, for a link somebody was sent, tells
 * them nothing about why the page they opened is not the page they expected,
 * and sends a crawler a 307 to the landing page for every revoked card.
 * `notFound()` gives a real 404 and a sentence.
 *
 * IT NAMES REVOCATION FOR ALL FOUR CASES, and that is a considered trade rather
 * than a sloppy message. The store cannot tell the four apart on purpose — a
 * token that never existed, a malformed one, a revoked one and an unparseable
 * snapshot all return null, so the page cannot be used to probe which tokens
 * are real (lib/share/store.ts). Copy that said "this link does not exist"
 * would be wrong for the revoked case, which is the overwhelmingly common one:
 * a stranger reaching this page almost always holds a link that worked
 * yesterday. So it says the likely thing in a way that confirms nothing — a
 * scanner guessing tokens gets this identical page either way.
 *
 * It mounts SiteDisclosureFooter itself, for the reason share/[token]/page.tsx
 * does: this route is outside every layout group that carries one, and it is
 * listed in MOUNTS in scripts/footer-copy-check.tsx in the same change.
 */

import { SiteDisclosureFooter } from '@/components/legal/SiteDisclosureFooter';

export default function ShareNotFound() {
  return (
    <>
      <main
        id="main-content"
        dir="rtl"
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: '32px 16px',
          background: 'var(--color-tg-bg)',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-tg-text)' }}>
          הקישור בוטל
        </h1>
        <p style={{ fontSize: 14, color: 'var(--color-tg-muted)', maxWidth: 320, lineHeight: 1.6 }}>
          הקישור הזה אינו זמין יותר. מי ששיתף אותו יכול ליצור קישור חדש.
        </p>
        <a
          href="https://reflecttrading.app"
          style={{
            marginTop: 8,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: 4,
            color: 'var(--color-tg-muted)',
            textDecoration: 'none',
          }}
          dir="ltr"
          aria-label="Reflect — reflecttrading.app"
        >
          REFLECT
        </a>
      </main>
      <SiteDisclosureFooter />
    </>
  );
}
