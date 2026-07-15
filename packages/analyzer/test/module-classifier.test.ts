import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceFileRecord } from "@braid/core";
import {
  classifyModule,
  classifyModuleIdentity,
  classifySourceFiles,
  findBarrelFiles,
  findPublicEntrypoints,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

const file = (
  filePath: string,
  topLevelStatements?: SourceFileRecord["topLevelStatements"],
): SourceFileRecord => ({
  path: filePath,
  linesOfCode: 1,
  exportedSymbols: [],
  importedFiles: [],
  isTestFile: false,
  ...(topLevelStatements ? { topLevelStatements } : {}),
});

describe("module classification", () => {
  it("assigns explicit entrypoint, barrel, root, feature, and infrastructure kinds", () => {
    expect(
      classifyModuleIdentity("src/index.ts", {
        publicEntrypoints: ["src/index.ts"],
      }),
    ).toEqual({ id: "entrypoint:index", kind: "entrypoint" });
    expect(
      classifyModuleIdentity("src/public.ts", {
        barrelFiles: ["src/public.ts"],
      }),
    ).toEqual({ id: "barrel:public", kind: "barrel" });
    expect(classifyModuleIdentity("src/core.ts")).toEqual({
      id: "root:core",
      kind: "root-file",
    });
    expect(classifyModuleIdentity("src/reporters/basic.ts")).toEqual({
      id: "reporters",
      kind: "feature",
    });
    expect(classifyModuleIdentity("src/internal/cache.ts")).toEqual({
      id: "internal",
      kind: "infrastructure",
    });
    expect(classifyModule("src/modules/users/service.ts")).toBe(
      "modules/users",
    );
  });

  it("keeps unrelated root files distinct and stable under file reordering", () => {
    const files = [file("src/core.ts"), file("src/utils.ts")];
    const first = [...classifySourceFiles(files, []).entries()];
    const second = [
      ...classifySourceFiles([...files].reverse(), []).entries(),
    ].sort(([left], [right]) => left.localeCompare(right));
    expect(first.sort(([left], [right]) => left.localeCompare(right))).toEqual(
      second,
    );
    expect(first.map(([, classification]) => classification.id).sort()).toEqual(
      ["root:core", "root:utils"],
    );
  });

  it("detects only implementation-free multi-export top-level barrels", () => {
    const barrel = file("src/public.ts", {
      imports: 1,
      reExports: 2,
      implementation: 0,
    });
    const implementation = file("src/core.ts", {
      imports: 1,
      reExports: 2,
      implementation: 1,
    });
    expect(findBarrelFiles([implementation, barrel])).toEqual([
      "src/public.ts",
    ]);
  });

  it("maps package exports and top-level index files to source entrypoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-entrypoints-"));
    temporaryDirectories.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        main: "./dist/index.js",
        exports: { "./cli": "./dist/subpaths/cli.js" },
      }),
    );
    const files = [
      file("src/index.ts"),
      file("src/subpaths/cli.ts"),
      file("src/implementation.ts"),
    ];
    expect(await findPublicEntrypoints(root, files)).toEqual([
      "src/index.ts",
      "src/subpaths/cli.ts",
    ]);
  });
});
