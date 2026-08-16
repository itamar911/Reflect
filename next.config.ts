import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only overlay. It defaults to the bottom-left corner, which is where
  // the accessibility trigger now lives — locally it sat on top of the
  // trigger and swallowed the click. Not present in production builds;
  // moved purely so the control is operable while developing.
  devIndicators: { position: 'top-left' },
};

export default nextConfig;
