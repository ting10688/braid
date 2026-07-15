import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  benchmarkRunSchema,
  type BenchmarkRun,
  type ProposalCaseResult,
} from "../models/benchmark.js";

const percent = (value: number): string => `${Math.round(value * 100)}%`;

export interface ProposalSummary {
  cases: number;
  expectedIssueCoverage: number;
  proposalValidity: number;
  topKCoverage: number;
  evidenceCoverage: number;
  evidenceCorrectness: number;
  riskAgreement: number;
  reversibilityAgreement: number;
  deterministicCases: number;
  falsePositives: number;
  cleanFalsePositives: number;
  sourceMutations: number;
  medianRuntimeMs: number;
}

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 1
    : values.reduce((sum, value) => sum + value, 0) / values.length;

export const proposalSummary = (run: BenchmarkRun): ProposalSummary => {
  const cases = run.cases.filter(
    (result): result is ProposalCaseResult => result.type === "proposal",
  );
  const expected = cases.reduce(
    (sum, result) => sum + result.expectedIssues,
    0,
  );
  const matched = cases.reduce(
    (sum, result) => sum + result.matchedIssueIds.length,
    0,
  );
  const proposals = cases.reduce(
    (sum, result) => sum + result.proposals.length,
    0,
  );
  return {
    cases: cases.length,
    expectedIssueCoverage: expected === 0 ? 1 : matched / expected,
    proposalValidity: proposals === 0 ? 1 : matched / proposals,
    topKCoverage: mean(
      cases
        .filter(({ expectedIssues }) => expectedIssues > 0)
        .map(({ topKCoverage }) => topKCoverage),
    ),
    evidenceCoverage: mean(
      cases
        .filter(({ proposals }) => proposals.length > 0)
        .map(({ evidenceCoverage }) => evidenceCoverage),
    ),
    evidenceCorrectness: mean(
      cases
        .filter(({ proposals }) => proposals.length > 0)
        .map(({ evidenceCorrectness }) => evidenceCorrectness),
    ),
    riskAgreement: mean(
      cases
        .filter(({ expectedIssues }) => expectedIssues > 0)
        .map(({ riskClassificationAgreement }) => riskClassificationAgreement),
    ),
    reversibilityAgreement: mean(
      cases
        .filter(({ expectedIssues }) => expectedIssues > 0)
        .map(
          ({ reversibilityClassificationAgreement }) =>
            reversibilityClassificationAgreement,
        ),
    ),
    deterministicCases: cases.filter(({ deterministic }) => deterministic)
      .length,
    falsePositives: cases.reduce(
      (sum, result) => sum + result.unexpectedProposalIds.length,
      0,
    ),
    cleanFalsePositives: cases
      .filter(({ expectedIssues }) => expectedIssues === 0)
      .reduce((sum, result) => sum + result.unexpectedProposalIds.length, 0),
    sourceMutations: cases.reduce(
      (sum, result) => sum + result.sourceMutations.length,
      0,
    ),
    medianRuntimeMs: mean(cases.map(({ durations }) => durations.medianMs)),
  };
};

const hasWarnings = (run: BenchmarkRun): boolean =>
  run.cases.some((result) =>
    result.type === "proposal"
      ? result.unmatchedIssueIds.length > 0 ||
        result.unexpectedProposalIds.length > 0 ||
        !result.deterministic ||
        !result.persistenceIdempotent ||
        result.sourceMutations.length > 0
      : !result.behaviorValid ||
        result.sourceMutations.length > 0 ||
        result.tolerances.some(({ withinTolerance }) => !withinTolerance),
  );

export const consoleReport = (run: BenchmarkRun): string => {
  const proposal = proposalSummary(run);
  const lines = [
    `Braid Bench: ${run.suiteId}`,
    "",
    `Cases: ${run.cases.length}`,
  ];
  if (proposal.cases > 0)
    lines.push(
      `Expected issue coverage: ${percent(proposal.expectedIssueCoverage)}`,
      `Proposal validity: ${percent(proposal.proposalValidity)}`,
      `Top-K coverage: ${percent(proposal.topKCoverage)}`,
      `Evidence coverage: ${percent(proposal.evidenceCoverage)}`,
      `Evidence correctness: ${percent(proposal.evidenceCorrectness)}`,
      `Risk classification agreement: ${percent(proposal.riskAgreement)}`,
      `Reversibility classification agreement: ${percent(proposal.reversibilityAgreement)}`,
      `Deterministic cases: ${proposal.deterministicCases}/${proposal.cases}`,
      `Source mutations: ${proposal.sourceMutations}`,
      `False positives on clean fixtures: ${proposal.cleanFalsePositives}`,
    );
  for (const result of run.cases) {
    if (result.type !== "static-comparison") continue;
    lines.push(
      `Comparison ${result.caseId}: ${result.behaviorValid ? "behavior valid" : "behavior invalid"}`,
      `  cycles ${result.before.architecture.circularDependencies} → ${result.after.architecture.circularDependencies}`,
      `  cross-module imports ${result.before.architecture.crossModuleImports} → ${result.after.architecture.crossModuleImports}`,
      `  source LOC ${result.before.architecture.sourceLinesOfCode} → ${result.after.architecture.sourceLinesOfCode}`,
    );
  }
  lines.push(
    "",
    `Result: completed${hasWarnings(run) ? " with warnings" : ""}`,
  );
  return `${lines.join("\n")}\n`;
};

const commandStatus = (exitCodes: readonly number[] | undefined): string =>
  !exitCodes
    ? "not configured"
    : exitCodes.every((code) => code === 0)
      ? "pass"
      : `fail (${exitCodes.join(", ")})`;

export const markdownReport = (run: BenchmarkRun): string => {
  const lines = [
    `# Braid Bench: ${run.suiteId}`,
    "",
    `Run: \`${run.runId}\`  `,
    `Expectation version: \`${run.expectationVersion}\`  `,
    `Braid: \`${run.braid.version}\` (${run.braid.commit ?? "uncommitted"})  `,
    `Benchmark: \`${run.benchmark.version}\` (${run.benchmark.commit ?? "uncommitted"})`,
    "",
    "## Environment",
    "",
    "| OS | Architecture | Node | pnpm | Git | CPU | Logical CPUs | Memory bytes |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: |",
    `| ${run.environment.operatingSystem} | ${run.environment.architecture} | ${run.environment.nodeVersion} | ${run.environment.pnpmVersion} | ${run.environment.gitVersion} | ${run.environment.cpuModel ?? "unknown"} | ${run.environment.logicalCpuCount} | ${run.environment.totalMemoryBytes} |`,
  ];
  for (const result of run.cases) {
    lines.push("", `## Case: ${result.caseId}`, "");
    if (result.type === "proposal") {
      lines.push(
        `- Expected issue coverage: ${percent(result.expectedIssueCoverage)}`,
        `- Proposal validity: ${percent(result.proposalValidity)}`,
        `- Top-K coverage: ${percent(result.topKCoverage)}`,
        `- Evidence coverage: ${percent(result.evidenceCoverage)}`,
        `- Evidence correctness: ${percent(result.evidenceCorrectness)}`,
        `- Risk agreement: ${percent(result.riskClassificationAgreement)}`,
        `- Reversibility agreement: ${percent(result.reversibilityClassificationAgreement)}`,
        `- Deterministic: ${result.deterministic ? "yes" : "no"}`,
        `- Persistence idempotent: ${result.persistenceIdempotent ? "yes" : "no"}`,
        `- Source mutations: ${result.sourceMutations.length}`,
        `- Matched: ${result.matchedIssueIds.join(", ") || "none"}`,
        `- Unmatched: ${result.unmatchedIssueIds.join(", ") || "none"}`,
        `- Unexpected proposals: ${result.unexpectedProposalIds.join(", ") || "none"}`,
      );
    } else {
      lines.push(
        "| Architecture metric | Before | After | Delta |",
        "| --- | ---: | ---: | ---: |",
      );
      for (const key of Object.keys(result.before.architecture) as Array<
        keyof typeof result.before.architecture
      >)
        lines.push(
          `| ${key} | ${result.before.architecture[key]} | ${result.after.architecture[key]} | ${result.architectureDelta[key]} |`,
        );
      lines.push(
        "",
        `Behavior valid: ${result.behaviorValid ? "yes" : "no"}  `,
        `Build: ${commandStatus(result.after.build?.exitCodes)}  `,
        `Tests: ${commandStatus(result.after.test?.exitCodes)}  `,
        `Build median: ${result.before.build?.timing.medianMs.toFixed(2) ?? "n/a"} ms → ${result.after.build?.timing.medianMs.toFixed(2) ?? "n/a"} ms  `,
        `Test median: ${result.before.test?.timing.medianMs.toFixed(2) ?? "n/a"} ms → ${result.after.test?.timing.medianMs.toFixed(2) ?? "n/a"} ms  `,
        `Artifact size: ${result.before.artifactSizeBytes ?? "n/a"} → ${result.after.artifactSizeBytes ?? "n/a"} bytes  `,
        `Change magnitude: +${result.changeMagnitude.filesAdded} / -${result.changeMagnitude.filesRemoved} / ~${result.changeMagnitude.filesModified} files; LOC delta ${result.changeMagnitude.sourceLineDelta}`,
        "",
        "Timing and artifact size are neutral guardrails, not architecture-quality scores.",
      );
      if (result.tolerances.length > 0) {
        lines.push(
          "",
          "| Guardrail | Regression | Tolerance | Result |",
          "| --- | ---: | ---: | --- |",
        );
        for (const tolerance of result.tolerances)
          lines.push(
            `| ${tolerance.metric} | ${tolerance.regressionPercent?.toFixed(2) ?? "n/a"}% | ${tolerance.tolerancePercent}% | ${tolerance.withinTolerance ? "within" : "exceeded"} |`,
          );
      }
    }
  }
  lines.push(
    "",
    "## Limitations",
    "",
    "Synthetic fixtures are not equivalent to real repositories. Human-authored expectations may be incomplete. Timing on uncontrolled machines is noisy, and these small samples do not establish statistical significance. Phase C agent orchestration and Phase D rollback execution are not implemented.",
    "",
  );
  return lines.join("\n");
};

export const writeReports = async (
  run: BenchmarkRun,
  outputDirectory: string,
): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "run.json"),
    `${JSON.stringify(run, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDirectory, "report.md"),
    markdownReport(run),
    "utf8",
  );
};

export const loadRun = async (input: string): Promise<BenchmarkRun> => {
  const file = input.endsWith(".json") ? input : path.join(input, "run.json");
  return benchmarkRunSchema.parse(JSON.parse(await readFile(file, "utf8")));
};

export const compareRunReport = (
  first: BenchmarkRun,
  second: BenchmarkRun,
  allowIncompatible = false,
): string => {
  if (
    !allowIncompatible &&
    (first.suiteId !== second.suiteId ||
      first.expectationVersion !== second.expectationVersion)
  )
    throw new Error("Runs use incompatible suite IDs or expectation versions");
  const a = proposalSummary(first);
  const b = proposalSummary(second);
  const metrics: Array<readonly [string, number, boolean]> = [
    ["Issue coverage", b.expectedIssueCoverage - a.expectedIssueCoverage, true],
    ["Proposal validity", b.proposalValidity - a.proposalValidity, true],
    ["Top-K coverage", b.topKCoverage - a.topKCoverage, true],
    [
      "Evidence correctness",
      b.evidenceCorrectness - a.evidenceCorrectness,
      true,
    ],
    ["False positives", b.falsePositives - a.falsePositives, false],
    [
      "Deterministic failures",
      b.cases - b.deterministicCases - (a.cases - a.deterministicCases),
      false,
    ],
    ["Source mutations", b.sourceMutations - a.sourceMutations, false],
    ["Median runtime (ms)", b.medianRuntimeMs - a.medianRuntimeMs, false],
  ];
  const improved = metrics.filter(
    ([, delta, higherIsBetter]) =>
      delta !== 0 && (higherIsBetter ? delta > 0 : delta < 0),
  );
  const regressed = metrics.filter(
    ([, delta, higherIsBetter]) =>
      delta !== 0 && (higherIsBetter ? delta < 0 : delta > 0),
  );
  const render = (
    items: ReadonlyArray<readonly [string, number, boolean]>,
  ): string[] =>
    items.length === 0
      ? ["- None"]
      : items.map(
          ([name, delta]) =>
            `- ${name}: ${delta > 0 ? "+" : ""}${delta.toFixed(3)}`,
        );
  return [
    `# Run comparison: ${first.runId} → ${second.runId}`,
    "",
    "Deltas are run B minus run A; no run is assumed to be newer or better.",
    "",
    "## Improvements",
    "",
    ...render(improved),
    "",
    "## Regressions",
    "",
    ...render(regressed),
    "",
  ].join("\n");
};
