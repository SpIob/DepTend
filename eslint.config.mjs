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

  // TypeScript files — full typed linting (core package only)
  {
    files: ["packages/**/*.ts"],
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
        tsconfigRootDir: import.meta.dirname,
        project: ["./tsconfig.json", "./packages/core/tsconfig.eslint.json"],
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

  // App and CLI TypeScript files — basic linting only (typed linting doesn't
  // resolve workspace package exports correctly, causing false positives)
  {
    files: ["app/**/*.ts", "app/**/*.tsx", "cli/**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strict,
      ...tseslint.configs.stylistic,
    ],
    plugins: {
      import: importPlugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "import/no-duplicates": "error",
      "import/no-cycle": "error",
      // Disable typed rules that produce false positives due to workspace
      // package export resolution issues
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
    },
  },

  // CLI-specific overrides
  {
    files: ["cli/src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
