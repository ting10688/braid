import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  benchmarkRunSchema,
  type BenchmarkRun,
  type IterationComparison,
  type MetricComparison,
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
  const acceptedActions = cases.reduce(
    (sum, result) => sum + result.matchedIssueIds.length,
    0,
  );
  const informational = cases.reduce(
    (sum, result) => sum + (result.informationalProposalIds?.length ?? 0),
    0,
  );
  const falsePositives = (result: ProposalCaseResult): number =>
    result.unexpectedProposalIds.length +
    (result.rejectedProposalIds?.length ?? 0);
  return {
    cases: cases.length,
    expectedIssueCoverage: expected === 0 ? 1 : matched / expected,
    proposalValidity:
      acceptedActions +
        informational +
        cases.reduce((sum, result) => sum + falsePositives(result), 0) ===
      0
        ? 1
        : (acceptedActions + informational) /
          (acceptedActions +
            informational +
            cases.reduce((sum, result) => sum + falsePositives(result), 0)),
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
      (sum, result) => sum + falsePositives(result),
      0,
    ),
    cleanFalsePositives: cases
      .filter(({ expectedIssues }) => expectedIssues === 0)
      .reduce((sum, result) => sum + falsePositives(result), 0),
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
        (result.rejectedProposalIds?.length ?? 0) > 0 ||
        (result.ambiguousProposalIds?.length ?? 0) > 0 ||
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
    `Protocol: ${run.manifest.protocolVersion}`,
    `Suite: ${run.suiteId}@${run.suiteVersion}`,
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
      `Flaky cases: ${run.cases.filter(({ flakiness }) => flakiness.flaky).length}`,
      `Source mutations: ${proposal.sourceMutations}`,
      `False positives: ${proposal.falsePositives}`,
      `Total setup duration: ${run.cases
        .filter(
          (result): result is ProposalCaseResult => result.type === "proposal",
        )
        .reduce((sum, result) => sum + (result.setupDurationMs ?? 0), 0)
        .toFixed(2)} ms`,
    );
  for (const repository of run.manifest.repositories ?? [])
    lines.push(
      `Repository ${repository.id}: ${repository.qualificationStatus}; install ${repository.installStatus}; build ${repository.buildStatus}; test ${repository.testStatus}; analysis ${repository.braidAnalysisStatus}`,
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
    `Protocol version: \`${run.manifest.protocolVersion}\`  `,
    `Suite version: \`${run.suiteVersion}\`  `,
    `Expectation version: \`${run.expectationVersion}\`  `,
    `Fixture manifest: \`${run.manifest.fixtureManifestHash}\`  `,
    `Configuration: \`${run.manifest.configurationHash}\`  `,
    `Braid: \`${run.braid.version}\` (${run.braid.commit ?? "uncommitted"})  `,
    `Benchmark: \`${run.benchmark.version}\` (${run.benchmark.commit ?? "uncommitted"})`,
    "",
    "## Environment",
    "",
    "| OS | Architecture | Node | pnpm | Git | CPU | Logical CPUs | Memory bytes |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: |",
    `| ${run.environment.operatingSystem} | ${run.environment.architecture} | ${run.environment.nodeVersion} | ${run.environment.pnpmVersion} | ${run.environment.gitVersion} | ${run.environment.cpuModel ?? "unknown"} | ${run.environment.logicalCpuCount} | ${run.environment.totalMemoryBytes} |`,
  ];
  if ((run.manifest.repositories?.length ?? 0) > 0) {
    lines.push(
      "",
      "## Repository qualification",
      "",
      "| Repository | Status | Install | Build | Test | Braid | Source files | LOC | Modules |",
      "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |",
      ...(run.manifest.repositories ?? []).map(
        (repository) =>
          `| ${repository.id} | ${repository.qualificationStatus} | ${repository.installStatus} | ${repository.buildStatus} | ${repository.testStatus} | ${repository.braidAnalysisStatus} | ${repository.sourceFiles} | ${repository.sourceLinesOfCode} | ${repository.moduleCount} |`,
      ),
      "",
      "The evaluated repositories are third-party inputs; Braid does not own them.",
    );
  }
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
        `- Flaky: ${result.flakiness.flaky ? "yes" : "no"}`,
        `- Flaky fields: ${result.flakiness.differences.map(({ field, repetitions }) => `${field} (runs ${repetitions.join(", ")})`).join("; ") || "none"}`,
        `- Correctness repetitions: ${result.correctnessRepetitions}`,
        `- Timing repetitions: ${result.durations.repetitions}`,
        `- Proposal median runtime: ${result.durations.medianMs.toFixed(2)} ms`,
        `- Setup duration: ${(result.setupDurationMs ?? 0).toFixed(2)} ms`,
        `- Persistence idempotent: ${result.persistenceIdempotent ? "yes" : "no"}`,
        `- Source mutations: ${result.sourceMutations.length}`,
        `- Matched: ${result.matchedIssueIds.join(", ") || "none"}`,
        `- Accepted top-level proposals: ${result.acceptedProposalIds?.join(", ") || "none"}`,
        `- Unmatched: ${result.unmatchedIssueIds.join(", ") || "none"}`,
        `- Unexpected proposals: ${result.unexpectedProposalIds.join(", ") || "none"}`,
        `- Rejected proposals / false positives: ${result.rejectedProposalIds?.join(", ") || "none"}`,
        `- Ambiguous proposals: ${result.ambiguousProposalIds?.join(", ") || "none"}`,
        `- Informational proposals: ${result.informationalProposalIds?.join(", ") || "none"}`,
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
        `Flaky: ${result.flakiness.flaky ? "yes" : "no"}  `,
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
    "Human-authored expectations may be incomplete. Timing on uncontrolled machines is noisy and is not a cross-machine blocking baseline. Optional runtime and browser tests remain explicitly excluded where recorded. Phase 3 migration execution is not implemented or exercised.",
    "",
  );
  return lines.join("\n");
};

export const writeReports = async (
  run: BenchmarkRun,
  outputDirectory: string,
): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true });
  await writeImmutableJson(
    path.join(outputDirectory, "manifest.json"),
    run.manifest,
  );
  await writeImmutableJson(
    path.join(outputDirectory, "fixture-manifest.json"),
    run.fixtureManifest,
  );
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
  const run = benchmarkRunSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  if (!input.endsWith(".json")) {
    const manifest = JSON.parse(
      await readFile(path.join(input, "manifest.json"), "utf8"),
    );
    const fixtures = JSON.parse(
      await readFile(path.join(input, "fixture-manifest.json"), "utf8"),
    );
    if (JSON.stringify(manifest) !== JSON.stringify(run.manifest))
      throw new Error(
        `Run manifest does not match immutable sidecar: ${input}`,
      );
    if (JSON.stringify(fixtures) !== JSON.stringify(run.fixtureManifest))
      throw new Error(
        `Fixture manifest does not match immutable sidecar: ${input}`,
      );
  }
  return run;
};

const immutableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const writeImmutableJson = async (
  file: string,
  value: unknown,
): Promise<void> => {
  const contents = immutableJson(value);
  try {
    await writeFile(file, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    )
      throw error;
    if ((await readFile(file, "utf8")) !== contents)
      throw new Error(`Refusing to replace immutable manifest: ${file}`);
  }
};

const metricLabel = (metric: string): string => {
  const labels: Readonly<Record<string, string>> = {
    topKCoverage: "Top-K coverage",
    falsePositiveCount: "False positives",
    medianRuntimeMs: "Median runtime",
    minimumRuntimeMs: "Minimum runtime",
    maximumRuntimeMs: "Maximum runtime",
    reportSizeBytes: "Report size",
  };
  return (
    labels[metric] ??
    metric
      .replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .replace(/^./u, (value) => value.toUpperCase())
  );
};

const metricValue = (
  metric: MetricComparison,
  value: number | boolean | string,
): string => {
  if (typeof value === "boolean") return value ? "pass" : "fail";
  if (typeof value !== "number") return value;
  if (
    [
      "expectedIssueCoverage",
      "proposalValidity",
      "topKCoverage",
      "evidenceCoverage",
      "evidenceCorrectness",
      "riskAgreement",
      "reversibilityAgreement",
    ].includes(metric.metric)
  )
    return percent(value);
  if (metric.metric.endsWith("RuntimeMs")) return `${value.toFixed(1)}ms`;
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
};

const comparisonCounts = (comparison: IterationComparison) => ({
  regressions: comparison.comparisons.filter(
    ({ status }) => status === "regressed",
  ).length,
  warnings: comparison.comparisons.filter(({ status }) => status === "warning")
    .length,
  improvements: comparison.comparisons.filter(
    ({ status }) => status === "improved",
  ).length,
});

export const comparisonConsoleReport = (
  comparison: IterationComparison,
): string => {
  const { regressions, warnings, improvements } = comparisonCounts(comparison);
  const lines = [
    "Braid iteration comparison",
    `Baseline: ${comparison.baseline.braidVersion} / ${comparison.baseline.braidCommit?.slice(0, 7) ?? "uncommitted"}`,
    `Candidate: ${comparison.candidate.braidVersion} / ${comparison.candidate.braidCommit?.slice(0, 7) ?? "uncommitted"}`,
    `Suite: ${comparison.candidate.manifest.suiteId}@${comparison.candidate.manifest.suiteVersion}`,
    `Protocol: ${comparison.candidate.manifest.protocolVersion}`,
    `Fixture: ${comparison.candidate.manifest.fixtureManifestHash}`,
    `Configuration: ${comparison.candidate.manifest.configurationHash}`,
  ];
  if (comparison.incompatibilities.length > 0)
    lines.push(
      "Incompatibilities:",
      ...comparison.incompatibilities.map((item) => `  - ${item}`),
    );
  if (comparison.environmentWarnings.length > 0)
    lines.push(
      "Environment warnings:",
      ...comparison.environmentWarnings.map((item) => `  - ${item}`),
    );
  for (const category of ["correctness", "stability", "cost"] as const) {
    lines.push(category[0]!.toUpperCase() + category.slice(1));
    for (const metric of comparison.comparisons.filter(
      (item) => item.category === category,
    ))
      lines.push(
        `${metricLabel(metric.metric)}: ${metricValue(metric, metric.baseline)} → ${metricValue(metric, metric.candidate)}  ${metric.status}`,
        `  ${metric.rationale}`,
      );
  }
  lines.push(
    `Result: ${comparison.overallResult.toUpperCase()}`,
    `Regressions: ${regressions}`,
    `Warnings: ${warnings}`,
    `Improvements: ${improvements}`,
  );
  return `${lines.join("\n")}\n`;
};

export const comparisonMarkdownReport = (
  comparison: IterationComparison,
): string => {
  const { regressions, warnings, improvements } = comparisonCounts(comparison);
  const lines = [
    "# Braid iteration comparison",
    "",
    `- Baseline: \`${comparison.baseline.braidVersion}\` / \`${comparison.baseline.braidCommit ?? "uncommitted"}\``,
    `- Candidate: \`${comparison.candidate.braidVersion}\` / \`${comparison.candidate.braidCommit ?? "uncommitted"}\``,
    `- Suite: \`${comparison.candidate.manifest.suiteId}@${comparison.candidate.manifest.suiteVersion}\``,
    `- Protocol: \`${comparison.candidate.manifest.protocolVersion}\``,
    `- Fixture manifest: \`${comparison.candidate.manifest.fixtureManifestHash}\``,
    `- Configuration: \`${comparison.candidate.manifest.configurationHash}\``,
    `- Policy: \`${comparison.policyVersion}\``,
    `- Environment: ${comparison.environmentWarnings.length === 0 ? "compatible" : "different; timing is informational"}`,
  ];
  if (comparison.incompatibilities.length > 0)
    lines.push(
      "",
      "## Incompatibilities",
      "",
      ...comparison.incompatibilities.map((item) => `- ${item}`),
    );
  if (comparison.environmentWarnings.length > 0)
    lines.push(
      "",
      "## Environment warnings",
      "",
      ...comparison.environmentWarnings.map((item) => `- ${item}`),
    );
  for (const category of ["correctness", "stability", "cost"] as const) {
    lines.push(
      "",
      `## ${category[0]!.toUpperCase() + category.slice(1)}`,
      "",
      "| Metric | Baseline | Candidate | Status | Rationale |",
      "| --- | ---: | ---: | --- | --- |",
    );
    for (const metric of comparison.comparisons.filter(
      (item) => item.category === category,
    ))
      lines.push(
        `| ${metricLabel(metric.metric)} | ${metricValue(metric, metric.baseline)} | ${metricValue(metric, metric.candidate)} | ${metric.status} | ${metric.rationale} |`,
      );
  }
  lines.push(
    "",
    "## Result",
    "",
    `**${comparison.overallResult.toUpperCase()}** — ${regressions} blocking regressions, ${warnings} warnings, ${improvements} improvements.`,
    "",
  );
  return lines.join("\n");
};

export const writeComparisonReports = async (
  comparison: IterationComparison,
  outputDirectory: string,
): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "comparison.json"),
    immutableJson(comparison),
    "utf8",
  );
  await writeFile(
    path.join(outputDirectory, "comparison.md"),
    comparisonMarkdownReport(comparison),
    "utf8",
  );
  await writeFile(
    path.join(outputDirectory, "comparison.txt"),
    comparisonConsoleReport(comparison),
    "utf8",
  );
};
