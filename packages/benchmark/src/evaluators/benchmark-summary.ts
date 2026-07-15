import type {
  BenchmarkRun,
  BenchmarkSummary,
  CommandMeasurement,
  ProposalCaseResult,
  StaticComparisonResult,
} from "../models/benchmark.js";
import { timingSummary } from "../runner/command-runner.js";

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 1
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const passed = (measurement: CommandMeasurement | null): boolean =>
  measurement === null ||
  (!measurement.timedOut && measurement.exitCodes.every((code) => code === 0));

export const benchmarkSummary = (run: BenchmarkRun): BenchmarkSummary => {
  const proposalCases = run.cases.filter(
    (result): result is ProposalCaseResult => result.type === "proposal",
  );
  const staticCases = run.cases.filter(
    (result): result is StaticComparisonResult =>
      result.type === "static-comparison",
  );
  const expected = proposalCases.reduce(
    (sum, result) => sum + result.expectedIssues,
    0,
  );
  const matched = proposalCases.reduce(
    (sum, result) => sum + result.matchedIssueIds.length,
    0,
  );
  const acceptedActions = proposalCases.reduce(
    (sum, result) => sum + result.matchedIssueIds.length,
    0,
  );
  const proposals = proposalCases.reduce(
    (sum, result) => sum + result.proposals.length,
    0,
  );
  const informational = proposalCases.reduce(
    (sum, result) => sum + (result.informationalProposalIds?.length ?? 0),
    0,
  );
  const falsePositives = proposalCases.reduce(
    (sum, result) =>
      sum +
      result.unexpectedProposalIds.length +
      (result.rejectedProposalIds?.length ?? 0),
    0,
  );
  const repositories = run.manifest.repositories ?? [];
  const timings = [
    ...proposalCases.map(({ durations }) => durations),
    ...staticCases.flatMap(({ before, after }) =>
      [before.runtimeBenchmark?.timing, after.runtimeBenchmark?.timing].filter(
        (timing): timing is NonNullable<typeof timing> => timing !== undefined,
      ),
    ),
  ];
  const timingMedians = timings.map(({ medianMs }) => medianMs);
  const combinedTiming =
    timingMedians.length > 0 ? timingSummary(timingMedians) : null;

  return {
    correctness: {
      expectedIssueCoverage: ratio(matched, expected),
      proposalValidity: ratio(
        acceptedActions + informational,
        acceptedActions + informational + falsePositives,
      ),
      topKCoverage: mean(
        proposalCases
          .filter(({ expectedIssues }) => expectedIssues > 0)
          .map(({ topKCoverage }) => topKCoverage),
      ),
      evidenceCoverage: mean(
        proposalCases
          .filter(({ proposals: items }) => items.length > 0)
          .map(({ evidenceCoverage }) => evidenceCoverage),
      ),
      evidenceCorrectness: mean(
        proposalCases
          .filter(({ proposals: items }) => items.length > 0)
          .map(({ evidenceCorrectness }) => evidenceCorrectness),
      ),
      riskAgreement: mean(
        proposalCases
          .filter(({ expectedIssues }) => expectedIssues > 0)
          .map(
            ({ riskClassificationAgreement }) => riskClassificationAgreement,
          ),
      ),
      reversibilityAgreement: mean(
        proposalCases
          .filter(({ expectedIssues }) => expectedIssues > 0)
          .map(
            ({ reversibilityClassificationAgreement }) =>
              reversibilityClassificationAgreement,
          ),
      ),
      falsePositiveCount: falsePositives,
      sourceMutations: run.cases.reduce(
        (sum, result) => sum + result.sourceMutations.length,
        0,
      ),
      buildSuccess:
        staticCases.every(
          ({ before, after }) => passed(before.build) && passed(after.build),
        ) && repositories.every(({ buildStatus }) => buildStatus === "passed"),
      testSuccess:
        staticCases.every(
          ({ before, after }) => passed(before.test) && passed(after.test),
        ) && repositories.every(({ testStatus }) => testStatus === "passed"),
      expectedExitCodeMatched: proposalCases.every(
        ({ expectedExitCodeMatched }) => expectedExitCodeMatched,
      ),
    },
    stability: {
      caseCount: run.cases.length,
      deterministicCases: proposalCases.filter(
        ({ deterministic }) => deterministic,
      ).length,
      flakyCases: run.cases.filter(({ flakiness }) => flakiness.flaky).length,
      proposalIdentityStable: proposalCases.every(
        ({ proposalIdentityStable }) => proposalIdentityStable,
      ),
      proposalOrderingStable: proposalCases.every(
        ({ proposalOrderingStable }) => proposalOrderingStable,
      ),
      persistenceIdempotent: proposalCases.every(
        ({ persistenceIdempotent }) => persistenceIdempotent,
      ),
    },
    cost: {
      medianRuntimeMs: combinedTiming?.medianMs ?? 0,
      minimumRuntimeMs:
        timings.length > 0
          ? Math.min(...timings.map(({ minimumMs }) => minimumMs))
          : 0,
      maximumRuntimeMs:
        timings.length > 0
          ? Math.max(...timings.map(({ maximumMs }) => maximumMs))
          : 0,
      proposalCount: proposals,
      reportSizeBytes: Buffer.byteLength(JSON.stringify(run), "utf8"),
    },
  };
};
