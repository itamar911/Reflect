import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // One-off root-level export copies of app components (not imported by
    // the app) — kept for sharing, out of lint scope.
    "stats_page_export.tsx",
    "PnlChart_export.tsx",
  ]),
]);

export default eslintConfig;
