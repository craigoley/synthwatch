// ESLint v9 flat config for the SynthWatch runner (Node.js + TypeScript backend).
// No browser/React/Next — this is a container service.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // Build output and deps are never linted.
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
