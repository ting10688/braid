import { describe, expect, it } from "vitest";
import { runGrowthModeBenchmark } from "../src/growth-mode-suite.js";

describe("Growth Mode live guard benchmark", () => {
  it("reports twenty independent same-session and hook cases", async () => {
    const report = await runGrowthModeBenchmark();

    expect(report).toMatchObject({
      suiteId: "growth-mode-live-guard",
      suiteVersion: "1.0.0",
      protocolVersion: "1.0.0",
      metrics: {
        totalCases: 20,
        passedCases: 20,
        classificationAccuracy: 1,
        newCycleRecall: 1,
        newCyclePrecision: 1,
        falseBlocks: 0,
        falseWarnings: 0,
        deterministicReportIds: 20,
        noChangeSkips: 1,
        cacheCorrect: 2,
        stopLoopPrevented: 1,
        sourceMutationsByBraid: 0,
        gitMutationsByBraid: 0,
        existingHooksPreserved: 2,
      },
      regressions: [],
    });
    expect(report.cases.every(({ passed }) => passed)).toBe(true);
    expect(report.cases.map(({ id }) => id)).toEqual([
      "baseline-initialization",
      "context-injection",
      "no-source-change",
      "safe-source-change",
      "new-cycle",
      "preexisting-cycle",
      "preexisting-cycle-removed",
      "oversized-threshold-crossed",
      "oversized-module-growth",
      "same-session-repair",
      "stop-blocks-once",
      "stop-no-loop",
      "shell-git-mutation",
      "untracked-typescript",
      "config-cache-invalidation",
      "worktree-isolation",
      "malformed-hook-fail-open",
      "analysis-failure-not-pass",
      "install-idempotent-preserves-hooks",
      "uninstall-owned-only",
    ]);
  }, 120_000);
});
