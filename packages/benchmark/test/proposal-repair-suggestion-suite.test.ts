import { describe, expect, it } from "vitest";
import { runProposalRepairSuggestionBenchmark } from "../src/proposal-repair-suggestion-suite.js";

describe("Phase 3.2 proposal-repair-suggestion benchmark", () => {
  it("reports fourteen independent advisory, repair, and execution cases", async () => {
    const report = await runProposalRepairSuggestionBenchmark();

    expect(report).toMatchObject({
      suiteId: "phase-3-2-proposal-repair-suggestions",
      suiteVersion: "1.0.0",
      protocolVersion: "1.0.0",
      metrics: {
        totalCases: 14,
        correctSuggestionStates: 14,
        suggestionStateAccuracy: 1,
        actionableTruePositives: 7,
        actionableFalsePositives: 0,
        actionableFalseNegatives: 0,
        actionableSuggestionPrecision: 1,
        actionableSuggestionRecall: 1,
        minimalSetsCorrect: 7,
        minimalSetAccuracy: 1,
        falseActionable: 0,
        falseUnavailable: 0,
        deterministicSuggestionIds: 14,
        deterministicSymbolOrders: 14,
        originalExecutorLaunchesPrevented: 1,
        revisedProposalsSuccessfullyReachingReadiness: 2,
        mainCheckoutMutations: 0,
        unauthorizedScopeAccepted: 0,
      },
      regressions: [],
      warnings: [],
    });
    expect(report.cases.every(({ passed }) => passed)).toBe(true);
    expect(report.cases.map(({ id }) => id)).toEqual([
      "missing-interface-actionable",
      "missing-type-alias-actionable",
      "multiple-required-companions",
      "minimal-unnecessary-companion",
      "retained-helper",
      "safe-imported-internal-type",
      "unresolved-declaration",
      "protected-public-entrypoint",
      "persistent-cycle",
      "symbol-budget",
      "legacy-evidence",
      "in-memory-revision-ready",
      "original-proposal-gated",
      "separately-revised-execution",
    ]);
    expect(report.cases[12]).toMatchObject({
      actualState: "actionable",
      executorLaunchCount: 0,
      originalExecutorLaunchPrevented: true,
      sideEffectsBeforeExecution: {
        worktreesCreated: 0,
        branchesCreated: 0,
        executionRecordsCreated: 0,
      },
    });
    expect(report.cases[13]).toMatchObject({
      actualState: "actionable",
      executorLaunchCount: 1,
      revisedProposalReachedReadiness: true,
      candidateCommitCreated: true,
      candidateDiscarded: true,
      mainCheckoutMutated: false,
    });
  }, 60_000);
});
