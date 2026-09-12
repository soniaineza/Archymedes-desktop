// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["out/**", "release/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // react-hooks 7's "recommended" preset bundles the React Compiler's
    // stricter analyses (no ref writes during render, no setState in effect
    // bodies, etc). Those assume compiler-managed memoization; this is plain
    // React 18, where "ref mirrors latest prop" and "derive state from an
    // effect" are standard, safe idioms. Keep just the two classic rules.
    files: ["src/renderer/**/*.{ts,tsx}"],
    ignores: ["src/renderer/test/**"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  prettier,
);
