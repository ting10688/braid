import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.artifacts/**",
      "**/node_modules/**",
      "**/.braid/**",
      "**/.braid-bench-cache/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "adapters/**/*.mjs",
      "demo/**/*.mjs",
      "plugins/**/*.mjs",
      "scripts/**/*.mjs",
    ],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        clearTimeout: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
