import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      ".repo.git/**",
      "coverage/**",
      "**/dist/**",
      "dist/**",
      "documentation/**",
      "MORE/**",
      "node_modules/**",
      "supabase/.temp/**",
      "supabase/functions/api/domain-bundle.mjs",
      "supabase/functions/api/pdf-worker.mjs",
      "playwright-report/**",
      "pnpm-lock.yaml",
      "test-results/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        Request: "readonly"
      }
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error"
    }
  },
  {
    // Scoped to apps/web/src/hooks - the OwnerApp state decomposition's new custom hooks - rather
    // than all of apps/web/src, since enabling this repo-wide immediately surfaces pre-existing
    // violations in files this effort isn't touching (e.g. AgentProfileSurface.tsx's hooks called
    // inside callbacks). Every domain hook this decomposition creates lands under this directory,
    // so this still catches missing/stale dependency-array entries in exactly the new code where
    // that risk applies (see docs/architecture/frontend-modularization-roadmap.md's named risk #1).
    files: ["apps/web/src/hooks/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
];
