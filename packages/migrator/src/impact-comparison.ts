import {
  architectureSnapshotSchema,
  impactComparisonSchema,
  migrationArchitectureImpactSchema,
  migrationExecutionPlanSchema,
  type ArchitectureSnapshot,
  type ImpactComparison,
  type ImpactObservation,
  type MigrationArchitectureImpact,
  type MigrationExecutionPlan,
  type SourceFileRecord,
} from "@braid/core";
import { pathMatchesPattern } from "./scope-policy.js";

export interface CompareMigrationImpactInput {
  plan: MigrationExecutionPlan;
  before: ArchitectureSnapshot;
  after: ArchitectureSnapshot;
  changedFiles?: readonly string[];
  protectedPaths?: readonly string[];
}

export interface ArchitectureValidationResult {
  passed: boolean;
  impact: MigrationArchitectureImpact;
  comparison: ImpactComparison;
  failures: string[];
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const metricChange = (before: number, after: number) => ({
  before,
  after,
  delta: after - before,
});

const declarationNames = (file: SourceFileRecord | undefined): Set<string> =>
  new Set(
    file?.declarations
      ? file.declarations.map(({ name }) => name)
      : (file?.exportedSymbols ?? []),
  );

const destinationFiles = (
  snapshot: ArchitectureSnapshot,
  destination: string,
): SourceFileRecord[] =>
  snapshot.repository.files
    .filter(
      ({ path }) => path === destination || path.startsWith(`${destination}/`),
    )
    .sort((left, right) => compare(left.path, right.path));

const cycleIdentity = (cycle: {
  modules: readonly string[];
  files: readonly string[];
}): string =>
  canonical({
    modules: [...cycle.modules].sort(compare),
    files: [...cycle.files].sort(compare),
  });

const publicSurface = (snapshot: ArchitectureSnapshot): string => {
  const files = new Map(
    snapshot.repository.files.map((file) => [file.path, file]),
  );
  return canonical(
    snapshot.repository.publicEntrypoints.sort(compare).map((entrypoint) => ({
      path: entrypoint,
      exports: [...(files.get(entrypoint)?.exportedSymbols ?? [])].sort(
        compare,
      ),
    })),
  );
};

const protectedPathMatches = (
  file: string,
  configuredPath: string,
): boolean => {
  const pattern = configuredPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (/[*?]/u.test(pattern)) return pathMatchesPattern(file, pattern);
  const prefix = pattern.replace(/\/$/u, "");
  return file === prefix || file.startsWith(`${prefix}/`);
};

const observedDelta = (
  observation: ImpactObservation,
  impact: MigrationArchitectureImpact,
): number | undefined => {
  switch (observation.metric) {
    case "circularDependencies":
      return impact.metrics.cycles.delta;
    case "oversizedFiles":
      return impact.metrics.oversizedFiles.delta;
    case "oversizedModules":
      return impact.metrics.oversizedModules.delta;
    case "crossModuleImports":
      return impact.metrics.crossModuleImports.delta;
    case "publicApiSurface":
      return impact.metrics.publicEntrypoints.delta;
    case "boundaryViolations":
      return undefined;
  }
};

const direction = (delta: number): "decrease" | "unchanged" | "increase" =>
  delta < 0 ? "decrease" : delta > 0 ? "increase" : "unchanged";

const mismatches = (
  certainty: "simulated" | "estimated",
  observations: readonly ImpactObservation[],
  impact: MigrationArchitectureImpact,
): string[] =>
  observations.flatMap((observation) => {
    if (observation.direction === "unknown") return [];
    const delta = observedDelta(observation, impact);
    if (delta === undefined)
      return [
        `${certainty} ${observation.metric}: actual metric is unavailable`,
      ];
    const actualDirection = direction(delta);
    if (actualDirection !== observation.direction)
      return [
        `${certainty} ${observation.metric}: predicted ${observation.direction}, actual ${actualDirection} (${delta >= 0 ? "+" : ""}${delta})`,
      ];
    if (observation.delta !== undefined && observation.delta !== delta)
      return [
        `${certainty} ${observation.metric}: predicted delta ${observation.delta}, actual ${delta}`,
      ];
    return [];
  });

export const compareMigrationImpact = (
  input: CompareMigrationImpactInput,
): ArchitectureValidationResult => {
  const plan = migrationExecutionPlanSchema.parse(input.plan);
  const before = architectureSnapshotSchema.parse(input.before);
  const after = architectureSnapshotSchema.parse(input.after);
  const sourceBefore = before.repository.files.find(
    ({ path }) => path === plan.expectedChange.sourceFile,
  );
  const sourceAfter = after.repository.files.find(
    ({ path }) => path === plan.expectedChange.sourceFile,
  );
  const destinationBefore = destinationFiles(
    before,
    plan.expectedChange.destinationDirectory,
  );
  const destinationAfter = destinationFiles(
    after,
    plan.expectedChange.destinationDirectory,
  );
  const destinationSymbols = new Set(
    destinationAfter.flatMap((file) => [...declarationNames(file)]),
  );
  const sourceByPath = new Map(
    after.repository.files.map((file) => [file.path, file]),
  );
  const companionLocators = plan.expectedChange.companionSymbols ?? [];
  const companionNames = new Set(companionLocators.map(({ symbol }) => symbol));
  const primaryLocators = plan.readiness
    ? plan.readiness.primarySymbols.map(({ file, name }) => ({
        file,
        symbol: name,
      }))
    : plan.expectedChange.symbols
        .filter((symbol) => !companionNames.has(symbol))
        .map((symbol) => ({
          file: plan.expectedChange.sourceFile,
          symbol,
        }));
  const selectedLocators = [...primaryLocators, ...companionLocators];
  const selectedSymbolsMoved = selectedLocators.every(
    ({ file, symbol }) =>
      !declarationNames(sourceByPath.get(file)).has(symbol) &&
      destinationSymbols.has(symbol),
  );
  const sourceModuleChanged =
    canonical(sourceBefore) !== canonical(sourceAfter);
  const destinationModuleChanged =
    destinationAfter.length > 0 &&
    canonical(destinationBefore) !== canonical(destinationAfter);
  const beforeCycles = new Set(before.repository.cycles.map(cycleIdentity));
  const newCycles = after.repository.cycles.filter(
    (cycle) => !beforeCycles.has(cycleIdentity(cycle)),
  ).length;
  const publicApiChanged = publicSurface(before) !== publicSurface(after);
  const protectedPathViolation = (input.changedFiles ?? []).some((file) =>
    (input.protectedPaths ?? []).some((pattern) =>
      protectedPathMatches(file, pattern),
    ),
  );
  const intendedOutcomeAchieved =
    selectedSymbolsMoved && sourceModuleChanged && destinationModuleChanged;
  const impact = migrationArchitectureImpactSchema.parse({
    selectedSymbolsMoved,
    sourceModuleChanged,
    destinationModuleChanged,
    metrics: {
      internalImports: metricChange(
        before.metrics.totalInternalImports,
        after.metrics.totalInternalImports,
      ),
      crossModuleImports: metricChange(
        before.metrics.crossModuleImports,
        after.metrics.crossModuleImports,
      ),
      cycles: metricChange(
        before.metrics.circularDependencies,
        after.metrics.circularDependencies,
      ),
      oversizedFiles: metricChange(
        before.metrics.oversizedFiles,
        after.metrics.oversizedFiles,
      ),
      oversizedModules: metricChange(
        before.metrics.oversizedModules,
        after.metrics.oversizedModules,
      ),
      publicEntrypoints: metricChange(
        before.metrics.publicEntrypointCount,
        after.metrics.publicEntrypointCount,
      ),
    },
    newCycles,
    publicApiChanged,
    protectedPathViolation,
    intendedOutcomeAchieved,
  });
  const comparison = impactComparisonSchema.parse({
    predicted: plan.expectedChange.predictedImpact,
    actual: impact,
    mismatches: [
      ...mismatches(
        "simulated",
        plan.expectedChange.predictedImpact.simulated,
        impact,
      ),
      ...mismatches(
        "estimated",
        plan.expectedChange.predictedImpact.estimated,
        impact,
      ),
    ].sort(compare),
  });
  const failures = [
    ...(!selectedSymbolsMoved ? ["selected-symbols-not-moved"] : []),
    ...(!sourceModuleChanged ? ["source-module-unchanged"] : []),
    ...(!destinationModuleChanged ? ["destination-module-unchanged"] : []),
    ...(newCycles > 0 ? ["new-cycle-introduced"] : []),
    ...(publicApiChanged ? ["public-api-regression"] : []),
    ...(protectedPathViolation ? ["protected-path-violation"] : []),
    ...(!intendedOutcomeAchieved ? ["intended-outcome-not-achieved"] : []),
  ];
  return {
    passed: failures.length === 0,
    impact,
    comparison,
    failures,
  };
};
