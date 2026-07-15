import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  architectureSnapshotSchema,
  createArchitectureSnapshot,
  repositoryModelSchema,
} from "@braid/core";
import { JsonSnapshotStore, serializeSnapshot } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

const createSnapshot = () =>
  createArchitectureSnapshot({
    projectRoot: "/project",
    gitCommit: null,
    configHash: "b".repeat(64),
    repository: repositoryModelSchema.parse({
      projectRoot: "/project",
      language: "typescript",
      files: [
        {
          path: "src/b.ts",
          linesOfCode: 1,
          exportedSymbols: ["z", "a"],
          importedFiles: [],
          isTestFile: false,
        },
        {
          path: "src/a.ts",
          linesOfCode: 1,
          exportedSymbols: [],
          importedFiles: [],
          isTestFile: false,
        },
      ],
      modules: [],
      imports: [],
      cycles: [],
      publicEntrypoints: [],
    }),
    metrics: {
      totalSourceFiles: 2,
      totalModules: 0,
      totalInternalImports: 0,
      totalExternalImports: 0,
      crossModuleImports: 0,
      circularDependencies: 0,
      oversizedFiles: 0,
      oversizedModules: 0,
      publicEntrypointCount: 0,
    },
    createdAt: new Date("2026-07-15T01:02:03.004Z"),
  });

describe("JSON snapshot store", () => {
  it("stable-sorts, validates, and atomically persists without overwriting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-store-"));
    temporaryDirectories.push(root);
    const snapshot = createSnapshot();
    const store = new JsonSnapshotStore(root);
    const destination = await store.save(snapshot);
    const stored = architectureSnapshotSchema.parse(
      JSON.parse(await readFile(destination, "utf8")),
    );

    expect(stored.repository.files.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    await expect(store.load(snapshot.id)).resolves.toEqual(stored);
    await expect(store.save(snapshot)).rejects.toThrow(
      /Could not persist snapshot/u,
    );
    expect(
      (await readdir(path.dirname(destination))).filter((file) =>
        file.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("serializes equivalent unordered arrays identically", () => {
    const snapshot = createSnapshot();
    const reordered = {
      ...snapshot,
      repository: {
        ...snapshot.repository,
        files: [...snapshot.repository.files].reverse(),
      },
    };
    expect(serializeSnapshot(reordered)).toBe(serializeSnapshot(snapshot));
  });
});
