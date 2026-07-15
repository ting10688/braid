import { describe, expect, it } from "vitest";
import {
  architectureSnapshotSchema,
  migrationExecutionPlanSchema,
  type ArchitectureSnapshot,
  type MigrationExecutionPlan,
  type SourceFileRecord,
} from "@braid/core";
import { compareMigrationImpact } from "../src/impact-comparison.js";

const file = (
  path: string,
  declarations: string[],
  exportedSymbols: string[] = declarations,
): SourceFileRecord => ({
  path,
  linesOfCode: declarations.length * 10,
  exportedSymbols,
  importedFiles: [],
  isTestFile: false,
  declarations: declarations.map((name, index) => ({
    name,
    kind: "variable",
    exported: exportedSymbols.includes(name),
    startLine: index + 1,
    endLine: index + 1,
    references: [],
  })),
});

const sourceBefore = file("src/orders/order.ts", [
  "createOrder",
  "notificationLog",
  "sentNotifications",
]);
const sourceAfter = file("src/orders/order.ts", ["createOrder"]);
const destinationAfter = file("src/notification/index.ts", [
  "notificationLog",
  "sentNotifications",
]);

interface SnapshotOptions {
  after?: boolean;
  files?: SourceFileRecord[];
  cycles?: { modules: string[]; files: string[] }[];
  publicEntrypoints?: string[];
  metrics?: Partial<ArchitectureSnapshot["metrics"]>;
}

const snapshot = ({
  after = false,
  files = after ? [sourceAfter, destinationAfter] : [sourceBefore],
  cycles = [],
  publicEntrypoints = [],
  metrics = {},
}: SnapshotOptions = {}): ArchitectureSnapshot =>
  architectureSnapshotSchema.parse({
    schemaVersion: 1,
    id: after
      ? "S-bbbbbbbbbbbb-20260715T000000001Z"
      : "S-aaaaaaaaaaaa-20260715T000000000Z",
    projectRoot: "/fixture",
    createdAt: after ? "2026-07-15T00:00:00.001Z" : "2026-07-15T00:00:00.000Z",
    gitCommit: "a".repeat(40),
    configHash: "b".repeat(64),
    sourceFingerprint: (after ? "d" : "c").repeat(64),
    repository: {
      projectRoot: "/fixture",
      language: "typescript",
      files,
      modules: [
        {
          id: "orders",
          kind: "feature",
          paths: ["src/orders/order.ts"],
          fileCount: 1,
          exportedSymbolCount: after ? 1 : 3,
          incomingDependencies: [],
          outgoingDependencies: after ? ["notification"] : [],
        },
        ...(after
          ? [
              {
                id: "notification",
                kind: "feature" as const,
                paths: ["src/notification/index.ts"],
                fileCount: 1,
                exportedSymbolCount: 2,
                incomingDependencies: ["orders"],
                outgoingDependencies: [],
              },
            ]
          : []),
      ],
      imports: [],
      cycles,
      publicEntrypoints,
    },
    metrics: {
      totalSourceFiles: files.length,
      totalModules: after ? 2 : 1,
      totalInternalImports: after ? 3 : 2,
      totalExternalImports: 0,
      crossModuleImports: after ? 2 : 1,
      circularDependencies: cycles.length,
      oversizedFiles: after ? 0 : 1,
      oversizedModules: 0,
      publicEntrypointCount: publicEntrypoints.length,
      ...metrics,
    },
  });

const plan = (): MigrationExecutionPlan =>
  migrationExecutionPlanSchema.parse({
    schemaVersion: 1,
    planId: "PL-0123456789abcdef",
    proposalId: "P-EM-12345678",
    proposalType: "extract-module",
    repository: {
      baseCommit: "a".repeat(40),
      sourceFingerprint: "c".repeat(64),
      configHash: "b".repeat(64),
      snapshotId: "S-aaaaaaaaaaaa-20260715T000000000Z",
    },
    approval: { requiredProposalId: "P-EM-12345678" },
    scope: {
      allowedExistingFiles: ["src/orders/order.ts"],
      allowedNewFilePatterns: ["src/notification/**"],
      allowedTestFiles: [],
      forbiddenFiles: ["package.json"],
      maximumChangedFiles: 8,
    },
    expectedChange: {
      sourceFile: "src/orders/order.ts",
      sourceModule: "orders",
      suggestedModule: "notification",
      destinationDirectory: "src/notification",
      symbols: ["notificationLog", "sentNotifications"],
      predictedImpact: {
        simulated: [],
        estimated: [
          {
            metric: "oversizedFiles",
            direction: "decrease",
            delta: -1,
            rationale: "The source should clear the size threshold.",
          },
          {
            metric: "crossModuleImports",
            direction: "unchanged",
            rationale: "Caller rewrites are estimated.",
          },
        ],
        unknowns: [],
      },
    },
    validation: {
      commands: [
        {
          id: "test",
          executable: "node",
          arguments: ["--test"],
        },
      ],
    },
    executor: {
      kind: "scripted-test",
      timeoutMs: 10_000,
      sandbox: "workspace-write",
    },
  });

describe("migration impact comparison", () => {
  it("accepts a real extraction and explicitly reports a harmless estimate mismatch", () => {
    const result = compareMigrationImpact({
      plan: plan(),
      before: snapshot(),
      after: snapshot({ after: true }),
      changedFiles: ["src/orders/order.ts", "src/notification/index.ts"],
    });
    expect(result.passed).toBe(true);
    expect(result.impact).toMatchObject({
      selectedSymbolsMoved: true,
      sourceModuleChanged: true,
      destinationModuleChanged: true,
      newCycles: 0,
      publicApiChanged: false,
      intendedOutcomeAchieved: true,
    });
    expect(result.impact.metrics.oversizedFiles.delta).toBe(-1);
    expect(result.comparison.mismatches).toContain(
      "estimated crossModuleImports: predicted unchanged, actual increase (+1)",
    );
  });

  it("fails when selected symbols remain in the original source", () => {
    const result = compareMigrationImpact({
      plan: plan(),
      before: snapshot(),
      after: snapshot({
        after: true,
        files: [sourceBefore, destinationAfter],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("selected-symbols-not-moved");
  });

  it("fails when the approved destination is missing", () => {
    const result = compareMigrationImpact({
      plan: plan(),
      before: snapshot(),
      after: snapshot({ after: true, files: [sourceAfter] }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "selected-symbols-not-moved",
        "destination-module-unchanged",
      ]),
    );
  });

  it("rejects a newly introduced dependency cycle", () => {
    const result = compareMigrationImpact({
      plan: plan(),
      before: snapshot(),
      after: snapshot({
        after: true,
        cycles: [
          {
            modules: ["notification", "orders"],
            files: ["src/notification/index.ts", "src/orders/order.ts"],
          },
        ],
      }),
    });
    expect(result.impact.newCycles).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("new-cycle-introduced");
  });

  it("rejects public API surface changes even when the entrypoint count is unchanged", () => {
    const beforeEntrypoint = file(
      "src/index.ts",
      ["createOrder"],
      ["createOrder"],
    );
    const afterEntrypoint = file("src/index.ts", ["newApi"], ["newApi"]);
    const result = compareMigrationImpact({
      plan: plan(),
      before: snapshot({
        files: [sourceBefore, beforeEntrypoint],
        publicEntrypoints: ["src/index.ts"],
      }),
      after: snapshot({
        after: true,
        files: [sourceAfter, destinationAfter, afterEntrypoint],
        publicEntrypoints: ["src/index.ts"],
      }),
    });
    expect(result.impact.metrics.publicEntrypoints.delta).toBe(0);
    expect(result.impact.publicApiChanged).toBe(true);
    expect(result.failures).toContain("public-api-regression");
  });

  it("rejects changed files matching a protected path", () => {
    const result = compareMigrationImpact({
      plan: plan(),
      before: snapshot(),
      after: snapshot({ after: true }),
      changedFiles: ["src/protected/internal.ts"],
      protectedPaths: ["src/protected/**"],
    });
    expect(result.impact.protectedPathViolation).toBe(true);
    expect(result.failures).toContain("protected-path-violation");
  });
});
