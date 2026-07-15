import { describe, expect, it } from "vitest";
import {
  architectureSnapshotSchema,
  createArchitectureSnapshot,
  migrationProposalSchema,
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

  it("validates and round-trips typed migration proposals", () => {
    const proposal = migrationProposalSchema.parse({
      schemaVersion: 1,
      id: "P-BC-81ce1120",
      snapshotId: "S-example",
      type: "break-cycle",
      title: "Break users to orders cycle edge",
      summary: "Remove the lowest-coupling module edge.",
      affectedFiles: ["src/users/user-service.ts"],
      affectedModules: ["orders", "users"],
      target: {
        type: "break-cycle",
        cycleModules: ["orders", "users"],
        cycleFiles: ["src/users/user-service.ts"],
        selectedEdge: {
          fromModule: "users",
          toModule: "orders",
          files: ["src/users/user-service.ts"],
        },
        suggestedStrategy: "introduce-boundary",
      },
      evidence: [
        {
          type: "dependency-cycle",
          modules: ["orders", "users"],
          files: ["src/users/user-service.ts"],
        },
      ],
      expectedImpact: {
        simulated: [
          {
            metric: "circularDependencies",
            direction: "decrease",
            delta: -1,
            rationale: "Graph simulation removes one detected cycle.",
          },
        ],
        estimated: [],
        unknowns: ["Implementation may introduce a boundary module."],
      },
      risk: { level: "low", points: 0, factors: [] },
      reversibility: { level: "easy", factors: ["Bounded file set."] },
      preconditions: ["Tests pass before migration."],
      constraints: ["Preserve behavior."],
      rollbackStrategy: "Restore the original import edge.",
      ranking: {
        severity: 3,
        confidence: 3,
        expectedBenefit: 3,
        riskPenalty: 0,
        deterministicTieBreaker: "P-BC-81ce1120",
      },
      alternatives: [
        {
          strategy: "dependency-inversion",
          selectedEdge: {
            fromModule: "orders",
            toModule: "users",
            files: ["src/users/user-service.ts"],
          },
          affectedFiles: ["src/users/user-service.ts"],
          affectedModules: ["orders", "users"],
          rationale: "Invert the reverse edge instead.",
          evidence: [
            {
              type: "dependency-cycle",
              modules: ["orders", "users"],
              files: ["src/users/user-service.ts"],
            },
          ],
          expectedImpact: {
            simulated: [],
            estimated: [],
            unknowns: [],
          },
          risk: { level: "low", points: 0, factors: [] },
          reversibility: {
            level: "conditional",
            factors: ["Restore the reverse edge."],
          },
        },
      ],
    });

    expect(
      migrationProposalSchema.parse(JSON.parse(JSON.stringify(proposal))),
    ).toEqual(proposal);
    expect(() =>
      migrationProposalSchema.parse({
        ...proposal,
        target: { ...proposal.target, type: "extract-module" },
      }),
    ).toThrow();
    expect(() =>
      migrationProposalSchema.parse({
        ...proposal,
        affectedFiles: ["/absolute/file.ts"],
      }),
    ).toThrow(/project-relative/u);
    expect(() =>
      migrationProposalSchema.parse({
        ...proposal,
        risk: { ...proposal.risk, level: "unsafe" },
      }),
    ).toThrow();
    expect(() =>
      migrationProposalSchema.parse({
        ...proposal,
        ranking: { ...proposal.ranking, confidence: 4 },
      }),
    ).toThrow();
  });

  it("keeps Phase 1 snapshots without declaration facts readable", () => {
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
    expect(architectureSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});
