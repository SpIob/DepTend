// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/*.js.map",
      "**/next-env.d.ts",
    ],
  },

  // Plain JS files (scripts/) — basic rules only, no type info needed
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    ...eslint.configs.recommended,
    rules: {
      "no-console": "off",
    },
  },

  // TypeScript files — full typed linting
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.json",
          "./app/tsconfig.json",
          "./cli/tsconfig.eslint.json",
          "./packages/core/tsconfig.eslint.json",
        ],
      },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "import/no-duplicates": "error",
      "import/no-cycle": "error",
    },
  },
  {
    files: ["cli/src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
