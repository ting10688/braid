import { describe, expect, it } from "vitest";
import { runMigrationExecutionBenchmark } from "../src/migration-execution-suite.js";

describe("Phase 3 migration execution benchmark", () => {
  it("keeps every smoke case explicit and blocking invariants green", async () => {
    const report = await runMigrationExecutionBenchmark({ smoke: true });

    expect(report).toMatchObject({
      suiteId: "phase-3-execution",
      suiteVersion: "1.0.0",
      protocolVersion: "1.0.0",
      metrics: {
        totalCases: 5,
        successfulSafeMigrations: 2,
        rejectedUnsafeMigrations: 3,
        mainCheckoutMutations: 0,
        scopeViolationsAccepted: 0,
        deterministicPlans: 5,
        completeExecutionRecords: 5,
      },
      regressions: [],
      warnings: [],
    });
    expect(report.cases.every(({ passed }) => passed)).toBe(true);
    expect(report.cases.map(({ id }) => id)).toEqual([
      "valid-notification-extraction",
      "wrong-approval-rejection",
      "unauthorized-file-modification",
      "executor-timeout",
      "safe-discard",
    ]);
  }, 30_000);
});
