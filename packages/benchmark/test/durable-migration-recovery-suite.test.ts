import { describe, expect, it } from "vitest";
import {
  DURABLE_MIGRATION_RECOVERY_CASE_IDS,
  createDurableMigrationRecoveryBenchmarkEvidence,
  durableMigrationRecoveryBenchmarkConsoleReport,
  runDurableMigrationRecoveryBenchmark,
  type DurableMigrationRecoveryCaseEvidence,
  type DurableMigrationRecoveryCaseId,
} from "../src/durable-migration-recovery-suite.js";

const changed = (
  id: DurableMigrationRecoveryCaseId,
  update: Partial<DurableMigrationRecoveryCaseEvidence>,
): DurableMigrationRecoveryCaseEvidence[] =>
  createDurableMigrationRecoveryBenchmarkEvidence().map((item) =>
    item.id === id ? { ...item, ...update } : item,
  );

describe("Phase 4 durable migration recovery benchmark", () => {
  it("reports the complete crash, integrity, ownership and concurrency matrix", async () => {
    const first = await runDurableMigrationRecoveryBenchmark();
    const second = await runDurableMigrationRecoveryBenchmark();

    expect(first).toMatchObject({
      suiteId: "phase-4-durable-migration-recovery",
      suiteVersion: "1.0.0",
      protocolVersion: "1.0.0",
      evidence: {
        mode: "reference-model",
        testFiles: [],
        verifiedCaseTokens: 0,
      },
      coverage: {
        requiredCases: 27,
        observedCases: 27,
        crashCases: 15,
        integrityCases: 6,
        ownershipCases: 3,
        concurrencyCases: 2,
        idempotencyCases: 1,
        missingCaseIds: [],
        duplicateCaseIds: [],
      },
      metrics: {
        totalCases: 27,
        passedCases: 27,
        classificationAccuracy: 1,
        resumablePrecision: 1,
        resumableRecall: 1,
        falseResumableCount: 0,
        executorRelaunchViolations: 0,
        duplicateCandidateResults: 0,
        candidateShaConsistency: 1,
        idempotentCompletion: 1,
        journalIntegrityDetection: 1,
        ownershipCleanupViolations: 0,
        mainMutations: 0,
        unauthorizedAcceptedFiles: 0,
        orphanedOwnedResources: 0,
        deterministicIdsAndOrdering: true,
      },
      regressions: [],
      warnings: [
        "reference-model evidence only; run the recovery CLI benchmark for controlled process evidence",
      ],
    });
    expect(first.cases.map(({ id }) => id)).toEqual(
      DURABLE_MIGRATION_RECOVERY_CASE_IDS,
    );
    expect(first.cases.every(({ passed }) => passed)).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(durableMigrationRecoveryBenchmarkConsoleReport(first)).toContain(
      "phase-4-durable-migration-recovery@1.0.0 (27 cases)",
    );
  });

  it("fails every blocking metric when its evidence contains a violation", async () => {
    const sha = "f".repeat(64);
    const cases: Array<{
      name: string;
      evidence: DurableMigrationRecoveryCaseEvidence[];
      metricFailed: (
        report: Awaited<
          ReturnType<typeof runDurableMigrationRecoveryBenchmark>
        >,
      ) => boolean;
    }> = [
      {
        name: "false resumable",
        evidence: changed("crash-after-executor-started", {
          actualClassification: "resumable",
        }),
        metricFailed: ({ metrics }) => metrics.falseResumableCount === 1,
      },
      {
        name: "executor relaunch",
        evidence: changed("crash-after-patch-captured", {
          executorLaunchesAfterRecovery: 1,
        }),
        metricFailed: ({ metrics }) => metrics.executorRelaunchViolations === 1,
      },
      {
        name: "duplicate candidate",
        evidence: changed("crash-after-candidate-created", {
          candidateResultCount: 2,
          candidateResultShas: [sha, sha],
          referenceCandidateSha: sha,
        }),
        metricFailed: ({ metrics }) => metrics.duplicateCandidateResults === 1,
      },
      {
        name: "candidate SHA mismatch",
        evidence: changed("crash-after-candidate-prepared", {
          candidateResultShas: [sha],
        }),
        metricFailed: ({ metrics }) => metrics.candidateShaConsistency < 1,
      },
      {
        name: "non-idempotent completion",
        evidence: changed("completed-execution-idempotency", {
          completionReplayNoOp: false,
        }),
        metricFailed: ({ metrics }) => metrics.idempotentCompletion < 1,
      },
      {
        name: "missed integrity failure",
        evidence: changed("tampered-journal-entry", {
          journalIntegrityFailureDetected: false,
        }),
        metricFailed: ({ metrics }) => metrics.journalIntegrityDetection < 1,
      },
      {
        name: "unsafe cleanup",
        evidence: changed("ambiguous-resource-ownership", {
          ownershipCleanupViolations: ["unknown-worktree-removed"],
        }),
        metricFailed: ({ metrics }) => metrics.ownershipCleanupViolations === 1,
      },
      {
        name: "main mutation",
        evidence: changed("unrelated-worktree-isolation", {
          mainMutations: 1,
        }),
        metricFailed: ({ metrics }) => metrics.mainMutations === 1,
      },
      {
        name: "unauthorized accepted file",
        evidence: changed("patch-hash-mismatch", {
          unauthorizedAcceptedFiles: ["package.json"],
        }),
        metricFailed: ({ metrics }) => metrics.unauthorizedAcceptedFiles === 1,
      },
      {
        name: "orphaned owned resource",
        evidence: changed("safe-owned-cleanup", {
          orphanedOwnedResources: ["staging-repository"],
        }),
        metricFailed: ({ metrics }) => metrics.orphanedOwnedResources === 1,
      },
      {
        name: "nondeterministic evidence",
        evidence: changed("concurrent-resume", {
          deterministicOrdering: false,
        }),
        metricFailed: ({ metrics }) =>
          metrics.deterministicIdsAndOrdering === false,
      },
    ];

    for (const item of cases) {
      const report = await runDurableMigrationRecoveryBenchmark(item.evidence);
      expect(item.metricFailed(report), item.name).toBe(true);
      expect(report.regressions.length, item.name).toBeGreaterThan(0);
      expect(report.metrics.passedCases, item.name).toBeLessThan(27);
    }
  });

  it("rejects incomplete or duplicate case coverage", async () => {
    const evidence = createDurableMigrationRecoveryBenchmarkEvidence();
    const missing = await runDurableMigrationRecoveryBenchmark(
      evidence.slice(1),
    );
    const duplicate = await runDurableMigrationRecoveryBenchmark([
      ...evidence,
      evidence[0]!,
    ]);

    expect(missing.coverage.missingCaseIds).toEqual(["crash-after-planned"]);
    expect(missing.metrics.deterministicIdsAndOrdering).toBe(false);
    expect(missing.regressions).toContain("missing cases: crash-after-planned");
    expect(duplicate.coverage.duplicateCaseIds).toEqual([
      "crash-after-planned",
    ]);
    expect(duplicate.metrics.deterministicIdsAndOrdering).toBe(false);
    expect(duplicate.regressions).toContain(
      "duplicate cases: crash-after-planned",
    );
  });
});
