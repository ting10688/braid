import { describe, expect, it } from "vitest";
import { runReadinessBenchmark } from "../src/readiness-suite.js";

describe("Phase 3.1 execution-readiness benchmark", () => {
  it("classifies ten independent cases and gates incomplete execution", async () => {
    const report = await runReadinessBenchmark();

    expect(report).toMatchObject({
      suiteId: "phase-3-1-execution-readiness",
      suiteVersion: "1.0.0",
      protocolVersion: "1.0.0",
      metrics: {
        totalCases: 10,
        correctClassifications: 10,
        readinessAccuracy: 1,
        companionFalsePositives: 0,
        companionFalseNegatives: 0,
        companionPrecision: 1,
        companionRecall: 1,
        deterministicOutputs: 10,
        falseReady: 0,
        falseNotReady: 0,
        executorLaunchesPrevented: 6,
        verifiedZeroLaunchRejections: 1,
        executorLaunches: 1,
        mainCheckoutMutations: 0,
      },
      regressions: [],
      warnings: [],
    });
    expect(report.cases.every(({ passed }) => passed)).toBe(true);
    expect(report.cases.map(({ id }) => id)).toEqual([
      "local-interface-companion",
      "local-type-alias-companion",
      "safe-retained-helper",
      "shared-type-retained",
      "unresolved-declaration",
      "predicted-reverse-dependency",
      "predicted-new-cycle",
      "file-budget-exceeded",
      "protected-public-entrypoint-companion",
      "complete-closure-execution",
    ]);
    expect(report.cases[0]).toMatchObject({
      orchestratorStatus: "rejected-before-executor",
      executorLaunchCount: 0,
      candidateCommitCreated: false,
      mainCheckoutMutated: false,
    });
    expect(report.cases.at(-1)).toMatchObject({
      orchestratorStatus: "succeeded",
      executorLaunchCount: 1,
      candidateCommitCreated: true,
      mainCheckoutMutated: false,
    });
  }, 60_000);
});
