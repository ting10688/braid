import type {
  BenchmarkRun,
  BenchmarkSummary,
  IterationComparison,
  MetricComparison,
  PolicyRule,
  RegressionPolicy,
  RunManifest,
} from "../models/benchmark.js";
import { manifestCompatibilityFields } from "../fixtures/fixture-manifest.js";
import { benchmarkSummary } from "./benchmark-summary.js";

interface ComparisonSource {
  runId: string;
  manifest: RunManifest;
  summary: BenchmarkSummary;
}

const policyRules = (
  policy: RegressionPolicy,
  level: "blocking" | "warnings",
  metric: string,
): PolicyRule[] => {
  const configured = policy[level][metric];
  return configured
    ? Array.isArray(configured)
      ? configured
      : [configured]
    : [];
};

interface RuleOutcome {
  violated: boolean;
  improved: boolean;
  rationale: string;
}

const evaluateRule = (
  rule: PolicyRule,
  baseline: number | boolean | string,
  candidate: number | boolean | string,
): RuleOutcome => {
  if ("requiredValue" in rule) {
    const violated = candidate !== rule.requiredValue;
    return {
      violated,
      improved: baseline !== rule.requiredValue && !violated,
      rationale: violated
        ? `requiredValue=${String(rule.requiredValue)} was not met`
        : `requiredValue=${String(rule.requiredValue)} was met`,
    };
  }
  if (typeof baseline !== "number" || typeof candidate !== "number")
    return {
      violated: true,
      improved: false,
      rationale: "numeric policy rule received a non-numeric metric",
    };
  if ("direction" in rule) {
    const nondecreasing = rule.direction === "nondecreasing";
    const violated = nondecreasing
      ? candidate < baseline
      : candidate > baseline;
    const improved = nondecreasing
      ? candidate > baseline
      : candidate < baseline;
    return {
      violated,
      improved,
      rationale: `${rule.direction} rule ${violated ? "was violated" : "was met"}`,
    };
  }
  if ("maximum" in rule) {
    const violated = candidate > rule.maximum;
    return {
      violated,
      improved: candidate < baseline && !violated,
      rationale: `maximum=${rule.maximum} ${violated ? "was exceeded" : "was met"}`,
    };
  }
  const allowed =
    "allowedRegressionPercent" in rule
      ? rule.allowedRegressionPercent
      : rule.allowedIncreasePercent;
  const increase =
    baseline === 0
      ? candidate > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : ((candidate - baseline) / Math.abs(baseline)) * 100;
  const violated = increase > allowed;
  return {
    violated,
    improved: candidate < baseline,
    rationale: `${"allowedRegressionPercent" in rule ? "allowedRegressionPercent" : "allowedIncreasePercent"}=${allowed}%; observed ${Number.isFinite(increase) ? `${increase.toFixed(2)}%` : "unbounded increase"}`,
  };
};

const categoryMetrics = (summary: BenchmarkSummary) =>
  Object.entries(summary).flatMap(([category, values]) =>
    Object.entries(values).map(([metric, value]) => ({
      category: category as MetricComparison["category"],
      metric,
      value,
    })),
  );

const compareMetric = (
  metric: string,
  category: MetricComparison["category"],
  baseline: number | boolean | string,
  candidate: number | boolean | string,
  policy: RegressionPolicy,
): MetricComparison => {
  const blocking = policyRules(policy, "blocking", metric).map((rule) =>
    evaluateRule(rule, baseline, candidate),
  );
  const warnings = policyRules(policy, "warnings", metric).map((rule) =>
    evaluateRule(rule, baseline, candidate),
  );
  const outcomes = [...blocking, ...warnings];
  const status = blocking.some(({ violated }) => violated)
    ? "regressed"
    : warnings.some(({ violated }) => violated)
      ? "warning"
      : outcomes.some(({ improved }) => improved)
        ? "improved"
        : outcomes.length > 0 || baseline === candidate
          ? "unchanged"
          : "warning";
  const rationale =
    outcomes.length > 0
      ? outcomes.map(({ rationale: reason }) => reason).join("; ")
      : baseline === candidate
        ? "No policy rule applies and the value is unchanged."
        : "No policy rule applies; the difference is informational.";
  return { metric, category, baseline, candidate, status, rationale };
};

const incompatibilities = (
  baseline: RunManifest,
  candidate: RunManifest,
): string[] => {
  const first = manifestCompatibilityFields(baseline);
  const second = manifestCompatibilityFields(candidate);
  const differences = Object.keys(first)
    .filter((field) => first[field] !== second[field])
    .map(
      (field) =>
        `${field}: ${String(first[field])} != ${String(second[field])}`,
    );
  for (const field of ["timingRepetitions", "warmupRuns"] as const)
    if (baseline.execution[field] !== candidate.execution[field])
      differences.push(
        `${field}: ${baseline.execution[field]} != ${candidate.execution[field]}`,
      );
  return differences;
};

const environmentWarnings = (
  baseline: RunManifest,
  candidate: RunManifest,
): string[] =>
  (Object.keys(baseline.environment) as Array<keyof RunManifest["environment"]>)
    .filter(
      (field) => baseline.environment[field] !== candidate.environment[field],
    )
    .map(
      (field) =>
        `${field}: ${baseline.environment[field]} != ${candidate.environment[field]}`,
    );

export const compareBenchmarkSummaries = (
  baseline: ComparisonSource,
  candidate: ComparisonSource,
  policy: RegressionPolicy,
  allowIncompatible = false,
): IterationComparison => {
  const incompatible = incompatibilities(baseline.manifest, candidate.manifest);
  const environment = environmentWarnings(
    baseline.manifest,
    candidate.manifest,
  );
  const candidateMetrics = new Map(
    categoryMetrics(candidate.summary).map((metric) => [metric.metric, metric]),
  );
  const comparisons =
    incompatible.length > 0 && !allowIncompatible
      ? [
          {
            metric: "compatibility",
            category: "correctness" as const,
            baseline: "compatible",
            candidate: "incompatible",
            status: "incompatible" as const,
            rationale: incompatible.join("; "),
          },
        ]
      : categoryMetrics(baseline.summary).flatMap((metric) => {
          const candidateMetric = candidateMetrics.get(metric.metric);
          if (!candidateMetric) return [];
          const comparison = compareMetric(
            metric.metric,
            metric.category,
            metric.value,
            candidateMetric.value,
            policy,
          );
          if (
            environment.length > 0 &&
            [
              "medianRuntimeMs",
              "minimumRuntimeMs",
              "maximumRuntimeMs",
            ].includes(metric.metric)
          )
            return [
              {
                ...comparison,
                status: "warning" as const,
                rationale: `${comparison.rationale}; timing is informational because environments differ: ${environment.join("; ")}`,
              },
            ];
          return [comparison];
        });
  if (incompatible.length > 0 && allowIncompatible)
    comparisons.unshift({
      metric: "compatibility",
      category: "correctness",
      baseline: "compatible",
      candidate: "incompatible",
      status: "incompatible",
      rationale: incompatible.join("; "),
    });
  const overallResult =
    incompatible.length > 0
      ? "incompatible"
      : comparisons.some(({ status }) => status === "regressed")
        ? "fail"
        : comparisons.some(({ status }) => status === "warning")
          ? "warning"
          : "pass";
  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    baseline: {
      runId: baseline.runId,
      braidVersion: baseline.manifest.braidVersion,
      braidCommit: baseline.manifest.braidCommit,
      manifest: baseline.manifest,
    },
    candidate: {
      runId: candidate.runId,
      braidVersion: candidate.manifest.braidVersion,
      braidCommit: candidate.manifest.braidCommit,
      manifest: candidate.manifest,
    },
    compatible: incompatible.length === 0,
    incompatibilities: incompatible,
    environmentWarnings: environment,
    comparisons,
    overallResult,
  };
};

export const compareBenchmarkRuns = (
  baseline: BenchmarkRun,
  candidate: BenchmarkRun,
  policy: RegressionPolicy,
  allowIncompatible = false,
): IterationComparison =>
  compareBenchmarkSummaries(
    {
      runId: baseline.runId,
      manifest: baseline.manifest,
      summary: benchmarkSummary(baseline),
    },
    {
      runId: candidate.runId,
      manifest: candidate.manifest,
      summary: benchmarkSummary(candidate),
    },
    policy,
    allowIncompatible,
  );
