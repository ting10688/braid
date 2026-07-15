import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@topiary/analyzer": fromRoot("./packages/analyzer/src/index.ts"),
      "@topiary/core": fromRoot("./packages/core/src/index.ts"),
      "@topiary/shared": fromRoot("./packages/shared/src/index.ts"),
      "@topiary/store": fromRoot("./packages/store/src/index.ts"),
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
