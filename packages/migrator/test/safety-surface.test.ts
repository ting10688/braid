import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { architectureSnapshotSchema } from "@braid/core";
import {
  captureSafetySurface,
  compareSafetySurfaces,
} from "../src/safety-surface.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const snapshot = (exportedSymbols = ["createOrder"]) =>
  architectureSnapshotSchema.parse({
    schemaVersion: 1,
    id: "S-aaaaaaaaaaaa-20260715T000000000Z",
    projectRoot: "/fixture",
    createdAt: "2026-07-15T00:00:00.000Z",
    gitCommit: "a".repeat(40),
    configHash: "b".repeat(64),
    repository: {
      projectRoot: "/fixture",
      language: "typescript",
      files: [
        {
          path: "src/index.ts",
          linesOfCode: 1,
          exportedSymbols,
          importedFiles: [],
          isTestFile: false,
        },
      ],
      modules: [],
      imports: [],
      cycles: [],
      publicEntrypoints: ["src/index.ts"],
    },
    metrics: {
      totalSourceFiles: 1,
      totalModules: 0,
      totalInternalImports: 0,
      totalExternalImports: 0,
      crossModuleImports: 0,
      circularDependencies: 0,
      oversizedFiles: 0,
      oversizedModules: 0,
      publicEntrypointCount: 1,
    },
  });

const repository = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-surface-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "-q", root]);
  await writeFile(path.join(root, "package.json"), '{"dependencies":{}}\n');
  await writeFile(path.join(root, "tsconfig.json"), "{}\n");
  await execFileAsync("mkdir", ["-p", path.join(root, "src")]);
  await writeFile(
    path.join(root, "src", "index.ts"),
    "export const createOrder = 1;\n",
  );
  await execFileAsync("git", ["-C", root, "add", "."]);
  return root;
};

describe("safety surface", () => {
  it("detects dependency/config and public export changes", async () => {
    const root = await repository();
    const before = await captureSafetySurface({
      repositoryRoot: root,
      publicEntrypoints: ["src/index.ts"],
      snapshot: snapshot(),
    });
    await writeFile(
      path.join(root, "package.json"),
      '{"dependencies":{"x":"1"}}\n',
    );
    await writeFile(
      path.join(root, "src", "index.ts"),
      "export const newApi = 1;\n",
    );
    const after = await captureSafetySurface({
      repositoryRoot: root,
      publicEntrypoints: ["src/index.ts"],
      snapshot: snapshot(["newApi"]),
    });

    expect(compareSafetySurfaces(before, after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "dependency-change" }),
        expect.objectContaining({ code: "public-entrypoint-change" }),
      ]),
    );
  });

  it("is stable when the protected surface is unchanged", async () => {
    const root = await repository();
    const first = await captureSafetySurface({
      repositoryRoot: root,
      publicEntrypoints: ["src/index.ts"],
      snapshot: snapshot(),
    });
    const second = await captureSafetySurface({
      repositoryRoot: root,
      publicEntrypoints: ["src/index.ts"],
      snapshot: snapshot(),
    });
    expect(second).toEqual(first);
    expect(compareSafetySurfaces(first, second)).toEqual([]);
  });
});
