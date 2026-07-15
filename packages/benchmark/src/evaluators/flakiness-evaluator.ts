import type { MigrationProposal } from "@braid/core";
import type { BenchmarkProtocol, Flakiness } from "../models/benchmark.js";
import { normalizedJson } from "../fixtures/fixture-manifest.js";

interface NormalizationContext {
  temporaryDirectories?: readonly string[];
}

const hasRule = (
  rules: BenchmarkProtocol["normalizationRules"],
  rule: BenchmarkProtocol["normalizationRules"][number],
): boolean => rules.includes(rule);

const normalizeString = (
  value: string,
  rules: BenchmarkProtocol["normalizationRules"],
  context: NormalizationContext,
): string => {
  let normalized = value;
  if (hasRule(rules, "temporary-directory-paths"))
    for (const directory of context.temporaryDirectories ?? [])
      normalized = normalized.replaceAll(directory, "<temporary-directory>");
  if (hasRule(rules, "generated-state-paths"))
    normalized = normalized.replaceAll(
      /\.braid\/state\/(?:snapshots|proposals)\/[^\s"']+/gu,
      ".braid/state/<generated>",
    );
  if (hasRule(rules, "timestamps"))
    normalized = normalized.replaceAll(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu,
      "<timestamp>",
    );
  return normalized;
};

export const normalizeAllowedVolatility = (
  value: unknown,
  rules: BenchmarkProtocol["normalizationRules"],
  context: NormalizationContext = {},
): unknown => {
  if (typeof value === "string") return normalizeString(value, rules, context);
  if (Array.isArray(value))
    return value.map((item) =>
      normalizeAllowedVolatility(item, rules, context),
    );
  if (value === null || typeof value !== "object") return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      (hasRule(rules, "run-ids") && key === "runId") ||
      (hasRule(rules, "timestamps") &&
        ["startedAt", "completedAt", "createdAt"].includes(key)) ||
      (hasRule(rules, "timing-samples") &&
        ["durationMs", "durations", "timing", "samples"].includes(key))
    )
      continue;
    if (
      hasRule(rules, "timestamps") &&
      key === "snapshotId" &&
      typeof item === "string"
    ) {
      normalized[key] = item.replace(/-\d{8}T\d{9}Z$/u, "-<timestamp>");
      continue;
    }
    normalized[key] = normalizeAllowedVolatility(item, rules, context);
  }
  return normalized;
};

export interface CorrectnessObservation {
  proposals: readonly MigrationProposal[];
  exitCode: number;
  sourceMutations: readonly string[];
}

export const normalizedCorrectnessOutput = (
  observation: CorrectnessObservation,
  rules: BenchmarkProtocol["normalizationRules"],
  context: NormalizationContext = {},
): unknown =>
  normalizeAllowedVolatility(
    {
      proposals: observation.proposals,
      exitCode: observation.exitCode,
      sourceMutations: [...observation.sourceMutations].sort(),
    },
    rules,
    context,
  );

export const detectFieldFlakiness = (
  fields: Readonly<Record<string, readonly unknown[]>>,
): Flakiness => {
  const differences: Flakiness["differences"] = [];
  for (const [field, values] of Object.entries(fields)) {
    if (values.length < 2) continue;
    const baseline = normalizedJson(values[0]);
    const differing = values
      .map((value, index) => ({
        value: normalizedJson(value),
        repetition: index + 1,
      }))
      .filter(({ value }, index) => index > 0 && value !== baseline)
      .map(({ repetition }) => repetition);
    if (differing.length > 0)
      differences.push({ field, repetitions: [1, ...differing] });
  }
  return {
    flaky: differences.length > 0,
    differences: differences.sort((left, right) =>
      left.field.localeCompare(right.field),
    ),
  };
};

export const detectProposalFlakiness = (
  observations: readonly CorrectnessObservation[],
  rules: BenchmarkProtocol["normalizationRules"],
  context: NormalizationContext = {},
): Flakiness => {
  const normalize = (value: unknown): unknown =>
    normalizeAllowedVolatility(value, rules, context);
  return detectFieldFlakiness({
    proposalCount: observations.map(({ proposals }) => proposals.length),
    proposalIds: observations.map(({ proposals }) =>
      proposals.map(({ id }) => id).sort(),
    ),
    proposalOrder: observations.map(({ proposals }) =>
      proposals.map(({ id }) => id),
    ),
    proposalTargets: observations.map(({ proposals }) =>
      normalize(proposals.map(({ target }) => target)),
    ),
    affectedFiles: observations.map(({ proposals }) =>
      normalize(proposals.map(({ affectedFiles }) => affectedFiles)),
    ),
    evidence: observations.map(({ proposals }) =>
      normalize(proposals.map(({ evidence }) => evidence)),
    ),
    risk: observations.map(({ proposals }) =>
      normalize(proposals.map(({ risk }) => risk)),
    ),
    reversibility: observations.map(({ proposals }) =>
      normalize(proposals.map(({ reversibility }) => reversibility)),
    ),
    ranking: observations.map(({ proposals }) =>
      normalize(proposals.map(({ ranking }) => ranking)),
    ),
    exitCode: observations.map(({ exitCode }) => exitCode),
    sourceMutations: observations.map(({ sourceMutations }) =>
      normalize(sourceMutations),
    ),
    proposalContent: observations.map((observation) =>
      normalizedCorrectnessOutput(observation, rules, context),
    ),
  });
};
