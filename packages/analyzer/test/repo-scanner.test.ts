import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseArchitectureConfig,
  DEFAULT_ARCHITECTURE_CONFIG,
} from "@braid/core";
import { scanRepository } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("repository scanner", () => {
  it("honors include/exclude patterns and resolves aliases and index files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-scanner-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src", "domain"), { recursive: true });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@domain/*": ["src/domain/*"] },
        },
      }),
    );
    await writeFile(
      path.join(root, "src", "domain", "index.ts"),
      "export const value = 1;\n",
    );
    await writeFile(
      path.join(root, "src", "index.ts"),
      'import { value } from "@domain/index"; export { value };\n',
    );
    await writeFile(
      path.join(root, "src", "ignored.test.ts"),
      "export const ignored = true;\n",
    );

    const config = parseArchitectureConfig(
      DEFAULT_ARCHITECTURE_CONFIG.replace(
        '    - "**/*.d.ts"',
        '    - "**/*.d.ts"\n    - "**/*.test.ts"',
      ),
    );
    const result = await scanRepository(root, config);

    expect(result.files.map((file) => file.path)).toEqual([
      "src/domain/index.ts",
      "src/index.ts",
    ]);
    expect(result.imports).toContainEqual({
      fromFile: "src/index.ts",
      specifier: "@domain/index",
      resolvedFile: "src/domain/index.ts",
    });
  });
});
