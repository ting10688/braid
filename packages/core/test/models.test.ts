import { describe, expect, it } from "vitest";
import {
  architectureSnapshotSchema,
  createArchitectureSnapshot,
  migrationSchema,
  repositoryModelSchema,
} from "../src/index.js";

const repository = repositoryModelSchema.parse({
  projectRoot: "/project",
  language: "typescript",
  files: [],
  modules: [],
  imports: [],
  cycles: [],
  publicEntrypoints: [],
});

describe("domain schemas", () => {
  it("creates a valid deterministic snapshot identifier", () => {
    const snapshot = createArchitectureSnapshot({
      projectRoot: "/project",
      gitCommit: null,
      configHash: "a".repeat(64),
      repository,
      metrics: {
        totalSourceFiles: 0,
        totalModules: 0,
        totalInternalImports: 0,
        totalExternalImports: 0,
        crossModuleImports: 0,
        circularDependencies: 0,
        oversizedFiles: 0,
        oversizedModules: 0,
        publicEntrypointCount: 0,
      },
      createdAt: new Date("2026-07-15T00:00:00.123Z"),
    });
    expect(snapshot.id).toMatch(/^S-[a-f0-9]{12}-20260715T000000123Z$/u);
    expect(architectureSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("defines migrations without implementing execution", () => {
    expect(
      migrationSchema.parse({
        schemaVersion: 1,
        id: "M-1",
        title: "Break order cycle",
        type: "break-cycle",
        parentSnapshotId: "S-1",
        status: "proposed",
        affectedFiles: [],
        dependencies: [],
        featureDependencies: [],
      }).status,
    ).toBe("proposed");
  });
});
