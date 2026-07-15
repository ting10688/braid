import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@braid/analyzer": fromRoot("./packages/analyzer/src/index.ts"),
      "@braid/core": fromRoot("./packages/core/src/index.ts"),
      "@braid/shared": fromRoot("./packages/shared/src/index.ts"),
      "@braid/store": fromRoot("./packages/store/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "examples/**/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    coverage: { enabled: false },
  },
});
