import { describe, expect, it } from "vitest";
import type { RepositoryModel } from "@braid/core";
import { calculateMetrics } from "../src/index.js";

describe("architecture metrics", () => {
  it("calculates raw counts with configured thresholds", () => {
    const repository: RepositoryModel = {
      projectRoot: "/project",
      language: "typescript",
      files: [
        {
          path: "src/a.ts",
          linesOfCode: 11,
          exportedSymbols: ["a"],
          importedFiles: ["src/b.ts"],
          isTestFile: false,
        },
        {
          path: "src/b.ts",
          linesOfCode: 2,
          exportedSymbols: [],
          importedFiles: ["zod"],
          isTestFile: false,
        },
      ],
      modules: [
        {
          id: "a",
          paths: ["src/a.ts"],
          fileCount: 1,
          exportedSymbolCount: 1,
          incomingDependencies: [],
          outgoingDependencies: ["b"],
        },
        {
          id: "b",
          paths: ["src/b.ts"],
          fileCount: 1,
          exportedSymbolCount: 0,
          incomingDependencies: ["a"],
          outgoingDependencies: [],
        },
      ],
      imports: [
        {
          fromFile: "src/a.ts",
          toFile: "src/b.ts",
          fromModule: "a",
          toModule: "b",
          kind: "internal",
        },
        {
          fromFile: "src/b.ts",
          toFile: "zod",
          fromModule: "b",
          toModule: "zod",
          kind: "external",
        },
      ],
      cycles: [],
      publicEntrypoints: ["src/a.ts"],
    };

    expect(
      calculateMetrics(repository, {
        oversized_file_lines: 10,
        oversized_module_files: 10,
        oversized_module_exports: 10,
        max_module_dependencies: 8,
      }),
    ).toEqual({
      totalSourceFiles: 2,
      totalModules: 2,
      totalInternalImports: 1,
      totalExternalImports: 1,
      crossModuleImports: 1,
      circularDependencies: 0,
      oversizedFiles: 1,
      oversizedModules: 0,
      publicEntrypointCount: 1,
    });
  });

  it("excludes entrypoint and barrel modules from ordinary oversized-module counts", () => {
    const repository = {
      projectRoot: "/project",
      language: "typescript" as const,
      files: [],
      modules: [
        {
          id: "entrypoint:index",
          kind: "entrypoint" as const,
          paths: ["src/index.ts"],
          fileCount: 50,
          exportedSymbolCount: 50,
          incomingDependencies: [],
          outgoingDependencies: [],
        },
        {
          id: "barrel:public",
          kind: "barrel" as const,
          paths: ["src/public.ts"],
          fileCount: 50,
          exportedSymbolCount: 50,
          incomingDependencies: [],
          outgoingDependencies: [],
        },
        {
          id: "root:worker",
          kind: "root-file" as const,
          paths: ["src/worker.ts"],
          fileCount: 1,
          exportedSymbolCount: 1,
          incomingDependencies: [],
          outgoingDependencies: [],
        },
      ],
      imports: [],
      cycles: [],
      publicEntrypoints: ["src/index.ts"],
    };
    expect(
      calculateMetrics(repository, {
        oversized_file_lines: 10,
        oversized_module_files: 10,
        oversized_module_exports: 10,
        max_module_dependencies: 8,
      }).oversizedModules,
    ).toBe(0);
  });
});
