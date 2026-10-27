import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only overlay. It defaults to the bottom-left corner, which is where
  // the accessibility trigger now lives — locally it sat on top of the
  // trigger and swallowed the click. Not present in production builds;
  // moved purely so the control is operable while developing.
  devIndicators: { position: 'top-left' },

  /**
   * The four TTFs the share card is rasterised with (REF-125 Stage 3) — two
   * Nunito weights for the card's own type, two Rubik weights carried only so a
   * Hebrew nickname has glyphs to fall back to.
   *
   * They are read at runtime with `readFileSync` (src/lib/share/cardFonts.ts),
   * which no bundler can follow into a file list — so without this entry they
   * are simply absent from the serverless bundle, and the route throws ENOENT
   * in production while working perfectly in `next dev`.
   *
   * This is the DECLARED form of something that was previously happening by
   * accident: writing the path as `new URL(..., import.meta.url)` made
   * Turbopack give up on static analysis and trace the WHOLE PROJECT into this
   * route's bundle ("Encountered unexpected file in NFT list"). The fonts were
   * included, but only because everything was. Naming them here is what makes
   * their presence a fact rather than a side effect of over-tracing.
   *
   * Keyed by route, so only the image route carries them.
   */
  outputFileTracingIncludes: {
    '/share/[token]/image': ['./src/lib/share/fonts/*.ttf'],
  },
};

export default nextConfig;
