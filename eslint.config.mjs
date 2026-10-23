import { defineConfig, globalIgnores } from "eslint/config";
import next from "@next/eslint-plugin-next";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * The rule set the project used through `eslint-config-next` (its
 * `core-web-vitals` + `typescript` presets: 112 rules, kept verbatim below),
 * inlined because that package requires the Next compiler — the app runs on
 * **vinext** and has no `next` dependency. The parser is
 * `typescript-eslint`'s instead of Next's Babel parser, which is only needed
 * by Next's own Babel plugins.
 */
const RULES =   {
    "react/display-name": 2,
    "react/jsx-key": 2,
    "react/jsx-no-comment-textnodes": 2,
    "react/jsx-no-duplicate-props": 2,
    "react/jsx-no-target-blank": "off",
    "react/jsx-no-undef": 2,
    "react/jsx-uses-react": 2,
    "react/jsx-uses-vars": 2,
    "react/no-children-prop": 2,
    "react/no-danger-with-children": 2,
    "react/no-deprecated": 2,
    "react/no-direct-mutation-state": 2,
    "react/no-find-dom-node": 2,
    "react/no-is-mounted": 2,
    "react/no-render-return-value": 2,
    "react/no-string-refs": 2,
    "react/no-unescaped-entities": 2,
    "react/no-unknown-property": "off",
    "react/no-unsafe": 0,
    "react/prop-types": "off",
    "react/react-in-jsx-scope": "off",
    "react/require-render-return": 2,
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "react-hooks/static-components": "error",
    "react-hooks/use-memo": "error",
    "react-hooks/preserve-manual-memoization": "error",
    "react-hooks/incompatible-library": "warn",
    "react-hooks/immutability": "error",
    "react-hooks/globals": "error",
    "react-hooks/refs": "error",
    "react-hooks/set-state-in-effect": "error",
    "react-hooks/error-boundaries": "error",
    "react-hooks/purity": "error",
    "react-hooks/set-state-in-render": "error",
    "react-hooks/unsupported-syntax": "warn",
    "react-hooks/config": "error",
    "react-hooks/gating": "error",
    "@next/next/google-font-display": "warn",
    "@next/next/google-font-preconnect": "warn",
    "@next/next/next-script-for-ga": "warn",
    "@next/next/no-async-client-component": "warn",
    "@next/next/no-before-interactive-script-outside-document": "warn",
    "@next/next/no-css-tags": "warn",
    "@next/next/no-head-element": "warn",
    "@next/next/no-html-link-for-pages": "error",
    "@next/next/no-img-element": "warn",
    "@next/next/no-page-custom-font": "warn",
    "@next/next/no-styled-jsx-in-document": "warn",
    "@next/next/no-sync-scripts": "error",
    "@next/next/no-title-in-document-head": "warn",
    "@next/next/no-typos": "warn",
    "@next/next/no-unwanted-polyfillio": "warn",
    "@next/next/inline-script-id": "error",
    "@next/next/no-assign-module-variable": "error",
    "@next/next/no-document-import-in-page": "error",
    "@next/next/no-duplicate-head": "error",
    "@next/next/no-head-import-in-document": "error",
    "@next/next/no-script-component-in-head": "error",
    "import/no-anonymous-default-export": "warn",
    "jsx-a11y/alt-text": [
      "warn",
      {
        "elements": [
          "img"
        ],
        "img": [
          "Image"
        ]
      }
    ],
    "jsx-a11y/aria-props": "warn",
    "jsx-a11y/aria-proptypes": "warn",
    "jsx-a11y/aria-unsupported-elements": "warn",
    "jsx-a11y/role-has-required-aria-props": "warn",
    "jsx-a11y/role-supports-aria-props": "warn",
    "constructor-super": "off",
    "getter-return": "off",
    "no-class-assign": "off",
    "no-const-assign": "off",
    "no-dupe-args": "off",
    "no-dupe-class-members": "off",
    "no-dupe-keys": "off",
    "no-func-assign": "off",
    "no-import-assign": "off",
    "no-new-native-nonconstructor": "off",
    "no-new-symbol": "off",
    "no-obj-calls": "off",
    "no-redeclare": "off",
    "no-setter-return": "off",
    "no-this-before-super": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-unsafe-negation": "off",
    "no-var": "error",
    "no-with": "off",
    "prefer-const": "error",
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "@typescript-eslint/ban-ts-comment": "error",
    "no-array-constructor": "off",
    "@typescript-eslint/no-array-constructor": "error",
    "@typescript-eslint/no-duplicate-enum-values": "error",
    "@typescript-eslint/no-empty-object-type": "error",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-extra-non-null-assertion": "error",
    "@typescript-eslint/no-misused-new": "error",
    "@typescript-eslint/no-namespace": "error",
    "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
    "@typescript-eslint/no-require-imports": "error",
    "@typescript-eslint/no-this-alias": "error",
    "@typescript-eslint/no-unnecessary-type-constraint": "error",
    "@typescript-eslint/no-unsafe-declaration-merging": "error",
    "@typescript-eslint/no-unsafe-function-type": "error",
    "no-unused-expressions": "off",
    "@typescript-eslint/no-unused-expressions": "warn",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": "warn",
    "@typescript-eslint/no-wrapper-object-types": "error",
    "@typescript-eslint/prefer-as-const": "error",
    "@typescript-eslint/prefer-namespace-keyword": "error",
    "@typescript-eslint/triple-slash-reference": "error"
  };

const eslintConfig = defineConfig([
  {
    name: "next",
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    plugins: {
      "@next/next": next,
      "@typescript-eslint": tseslint.plugin,
      react,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
      import: importPlugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    settings: {
      react: { version: "detect" },
      "import/parsers": { "@typescript-eslint/parser": [".ts", ".mts", ".cts", ".tsx", ".d.ts"] },
      "import/resolver": {
        node: { extensions: [".js", ".jsx", ".ts", ".tsx"] },
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: RULES,
  },
  {
    // Worker code must never read a DOM global. `tsconfig` loads `lib.dom`, so
    // `status`, `name`, `top`, `origin`, `event`… typecheck — and then throw a
    // `ReferenceError` the moment the route runs in workerd (a `status` typo
    // once made `broadcastObjectDelete` skip every list channel for months).
    // The modules below are client-side on purpose (React hooks, DOM APIs) and
    // are exempted one by one: a new file has to be added deliberately.
    name: "no-dom-globals-in-workers",
    files: ["app/**/route.ts", "app/**/inbox/route.ts", "src/**/*.ts", "proxy.ts", "lib/**/*.{ts,tsx}"],
    ignores: [
      "lib/audio-visualizer.ts",
      "lib/client-api.ts",
      "lib/i18n.tsx",
      "lib/media/player-preferences.ts",
      "lib/media/remote-playback.ts",
      "lib/mls/keypackage.ts",
      "lib/palettes.ts",
      "lib/streaming/use-new-statuses.ts",
      "lib/streaming/use-timeline-cache.ts",
      "lib/streaming/use-timeline-stream.ts",
      "lib/webrtc/use-call.ts",
      "lib/**/__tests__/**",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        "status", "name", "origin", "top", "event", "location", "document", "window",
        "self", "parent", "frames", "history", "screen", "navigator", "alert", "confirm",
        "prompt", "addEventListener", "removeEventListener", "localStorage", "sessionStorage",
        "requestAnimationFrame", "cancelAnimationFrame", "innerWidth", "innerHeight",
        "scrollY", "scrollX", "scrollTo", "customElements", "matchMedia", "getComputedStyle",
        "XMLHttpRequest", "WebSocket", "FileReader", "IntersectionObserver", "ResizeObserver",
      ],
    },
  },
  {
    // Decorators must never reach a bundle: Vite 8 transforms with Oxc, which
    // keeps decorator syntax at any target, and workerd's V8 cannot parse it —
    // a decorated class took the whole deployed Worker down at startup with
    // `SyntaxError: Invalid or unexpected token` (the Agents SDK's
    // `@callable()`). Register the metadata explicitly instead
    // (`exposeMethod` in `lib/guardian/agent.ts`).
    name: "no-decorators",
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Decorator",
          message:
            "Decorators do not survive this toolchain (Oxc keeps them, workerd cannot parse them) and crash the Worker at startup. Use a plain function or an explicit registration instead.",
        },
      ],
    },
  },
  // The old config ignored these too.
  globalIgnores([
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
