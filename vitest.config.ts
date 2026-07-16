import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@braid/analyzer": fromRoot("./packages/analyzer/src/index.ts"),
      "@braid/benchmark": fromRoot("./packages/benchmark/src/index.ts"),
      "@braid/core": fromRoot("./packages/core/src/index.ts"),
      "@braid/guard": fromRoot("./packages/guard/src/index.ts"),
      "@braid/migrator/testing": fromRoot(
        "./packages/migrator/src/testing/notification-fixture.ts",
      ),
      "@braid/migrator": fromRoot("./packages/migrator/src/index.ts"),
      "@braid/planner": fromRoot("./packages/planner/src/index.ts"),
      "@braid/shared": fromRoot("./packages/shared/src/index.ts"),
      "@braid/store": fromRoot("./packages/store/src/index.ts"),
    },
  },
  test: {
    include: [
      "apps/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "examples/**/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "packages/migrator/test/fixtures/**",
    ],
    coverage: { enabled: false },
  },
});
