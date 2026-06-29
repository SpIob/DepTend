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
    ],
  },

  // Base JS recommended rules
  eslint.configs.recommended,

  // TypeScript rules for all TS/TSX files
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // TypeScript project configuration
  {
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.base.json",
          "./app/tsconfig.json",
          "./cli/tsconfig.json",
          "./packages/core/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Import plugin
  {
    plugins: {
      import: importPlugin,
    },
    rules: {
      "import/no-duplicates": "error",
      "import/no-cycle": "error",
      "import/no-unused-modules": "warn",
    },
  },

  // Project-wide custom rules
  {
    rules: {
      // Enforce explicitness
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",

      // Keep things honest
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // Hygiene
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Relax rules for scripts/ (plain JS ingestion jobs are allowed here)
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  }
);
