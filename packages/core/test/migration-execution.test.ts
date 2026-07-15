import { describe, expect, it } from "vitest";
import {
  migrationExecutionPlanSchema,
  migrationExecutionRecordSchema,
  sourceFingerprintSchema,
} from "../src/index.js";

const hash = "a".repeat(64);
const commit = "b".repeat(40);

const plan = {
  schemaVersion: 1,
  planId: "PL-1234567890abcdef",
  proposalId: "P-EM-a18d42f3",
  proposalType: "extract-module",
  repository: {
    baseCommit: commit,
    sourceFingerprint: hash,
    configHash: hash,
    snapshotId: "S-example",
  },
  approval: { requiredProposalId: "P-EM-a18d42f3" },
  scope: {
    allowedExistingFiles: ["src/orders/order-service.ts"],
    allowedNewFilePatterns: ["src/notification/**"],
    allowedTestFiles: ["test/order-service.test.ts"],
    forbiddenFiles: ["package.json", "pnpm-lock.yaml"],
    maximumChangedFiles: 8,
  },
  expectedChange: {
    sourceFile: "src/orders/order-service.ts",
    sourceModule: "orders",
    suggestedModule: "notification",
    destinationDirectory: "src/notification",
    symbols: ["notificationLog", "sentNotifications"],
    predictedImpact: { simulated: [], estimated: [], unknowns: [] },
  },
  validation: {
    commands: [
      {
        id: "typecheck",
        stage: "typecheck",
        executable: "pnpm",
        arguments: ["typecheck"],
        workingDirectory: ".",
        timeoutMs: 120_000,
        required: true,
        stdoutLimit: 65_536,
        stderrLimit: 65_536,
      },
    ],
  },
  executor: {
    kind: "codex",
    timeoutMs: 900_000,
    sandbox: "workspace-write",
  },
} as const;

describe("migration execution schemas", () => {
  it("validates deterministic plans without absolute paths", () => {
    expect(migrationExecutionPlanSchema.parse(plan)).toEqual(plan);
    expect(() =>
      migrationExecutionPlanSchema.parse({
        ...plan,
        scope: {
          ...plan.scope,
          allowedExistingFiles: ["/private/source.ts"],
        },
      }),
    ).toThrow(/project-relative/u);
  });

  it("validates source manifests and execution attempts", () => {
    expect(
      sourceFingerprintSchema.parse({
        schemaVersion: 1,
        algorithm: "sha256",
        hash,
        entries: [
          {
            path: "src/index.ts",
            fileType: "file",
            contentHash: hash,
            executable: false,
          },
        ],
      }).hash,
    ).toBe(hash);

    const planned = {
      schemaVersion: 1,
      executionId: "E-12345678-1234-1234-1234-123456789abc",
      planId: plan.planId,
      proposalId: plan.proposalId,
      status: "planned",
      startedAt: "2026-07-15T00:00:00.000Z",
      baseCommit: commit,
      executor: { kind: "codex" },
      scope: {
        allowedFiles: ["src/orders/order-service.ts"],
        changedFiles: [],
        addedFiles: [],
        deletedFiles: [],
        violations: [],
      },
      validation: [],
      architecture: {
        beforeSnapshotId: "S-example",
        predictedImpact: plan.expectedChange.predictedImpact,
      },
      fingerprints: {
        mainBefore: hash,
        candidateBefore: hash,
      },
      artifacts: {},
    } as const;
    expect(migrationExecutionRecordSchema.parse(planned).status).toBe(
      "planned",
    );
    expect(
      migrationExecutionRecordSchema.safeParse({
        ...planned,
        status: "succeeded",
        completedAt: "2026-07-15T00:05:00.000Z",
      }).success,
    ).toBe(false);

    const impact = {
      selectedSymbolsMoved: true,
      sourceModuleChanged: true,
      destinationModuleChanged: true,
      metrics: {
        internalImports: { before: 0, after: 1, delta: 1 },
        crossModuleImports: { before: 0, after: 1, delta: 1 },
        cycles: { before: 0, after: 0, delta: 0 },
        oversizedFiles: { before: 1, after: 0, delta: -1 },
        oversizedModules: { before: 0, after: 0, delta: 0 },
        publicEntrypoints: { before: 0, after: 0, delta: 0 },
      },
      newCycles: 0,
      publicApiChanged: false,
      protectedPathViolation: false,
      intendedOutcomeAchieved: true,
    } as const;
    const succeeded = {
      ...planned,
      status: "succeeded" as const,
      completedAt: "2026-07-15T00:05:00.000Z",
      candidateBranch: "braid/exec/12345678",
      executor: {
        kind: "codex",
        sandbox: "workspace-write",
        exitCode: 0,
        timedOut: false,
      },
      scope: {
        ...planned.scope,
        changedFiles: ["src/orders/order-service.ts"],
      },
      validation: [
        {
          commandId: "typecheck",
          stage: "typecheck" as const,
          status: "passed" as const,
          required: true,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
      architecture: {
        ...planned.architecture,
        afterSnapshotId: "S-after",
        actualImpact: impact,
        comparison: {
          predicted: planned.architecture.predictedImpact,
          actual: impact,
          mismatches: [],
        },
      },
      fingerprints: {
        ...planned.fingerprints,
        mainAfter: hash,
        candidateAfter: hash,
        diffHash: hash,
      },
      artifacts: {
        eventLog: "codex-events.jsonl",
        finalSummary: "codex-summary.json",
        patch: "candidate.patch",
        validationReport: "validation.json",
      },
    };
    expect(migrationExecutionRecordSchema.safeParse(succeeded).success).toBe(
      true,
    );
    expect(
      migrationExecutionRecordSchema.safeParse({
        ...succeeded,
        validation: [
          {
            ...succeeded.validation[0],
            status: "timeout",
            required: false,
            exitCode: null,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      migrationExecutionRecordSchema.safeParse({
        ...succeeded,
        scope: {
          ...succeeded.scope,
          deletedFiles: ["src/orders/order-service.ts"],
        },
      }).success,
    ).toBe(false);
  });
});
