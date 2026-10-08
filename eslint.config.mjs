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
    // Generated / tooling output:
    "dist/**",
    ".cloudflare/**",
    ".wrangler/**",
    ".vinext/**",
    ".turbo/**",
    "coverage/**",
    // Static assets (swagger-ui-dist is vendored minified third-party code)
    "public/**",
  ]),
]);

export default eslintConfig;
