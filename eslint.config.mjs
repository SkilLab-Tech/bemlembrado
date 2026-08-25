import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat config. Type-aware linting (projectService) over src + test (the files
 * tsconfig includes). no-explicit-any = error is the ESLint half of the no-`any`
 * machine gate (tsc strict is the other half). Config files and generated
 * declarations are ignored — they are not product code and are not in tsconfig.
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      ".wrangler/",
      "dist/",
      "coverage/",
      "**/*.d.ts",
      "vitest.config.ts",
      "eslint.config.mjs",
      "commitlint.config.mjs",
      "scripts/", // standalone node ops scripts, not part of the worker tsconfig
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
