import type {
  ArchitectureConfig,
  GrowthModeFinding,
  GrowthModeReportStatus,
  ImportEdge,
  ModuleRecord,
  RepositoryModel,
} from "@braid/core";
import { binaryCompare, canonicalFinding, sha256 } from "./canonical.js";
import type { GrowthBaselineCapture } from "./state-store.js";

export interface GrowthComparisonInput {
  baseline: GrowthBaselineCapture;
  current: {
    repository: RepositoryModel;
    warnings: readonly string[];
  };
  config: ArchitectureConfig;
  changedPaths: readonly string[];
}

export interface GrowthComparisonResult {
  status: GrowthModeReportStatus;
  findings: GrowthModeFinding[];
  affectedPaths: string[];
}

const canonicalCycleValues = (values: readonly string[]): string[] => {
  const rotations = values.map((_, index) => [
    ...values.slice(index),
    ...values.slice(0, index),
  ]);
  return (
    rotations.sort((left, right) =>
      binaryCompare(left.join("\0"), right.join("\0")),
    )[0] ?? []
  );
};

const cycleKey = (cycle: RepositoryModel["cycles"][number]): string =>
  sha256({
    modules: canonicalCycleValues(cycle.modules),
    files: canonicalCycleValues(cycle.files),
  });

const evidenceEdges = (
  cycle: RepositoryModel["cycles"][number],
  imports: readonly ImportEdge[],
): GrowthModeFinding["edges"] => {
  const files = new Set(cycle.files);
  return imports
    .filter(
      (edge) =>
        edge.kind === "internal" &&
        files.has(edge.fromFile) &&
        files.has(edge.toFile),
    )
    .map(({ fromFile, toFile, fromModule, toModule, typeOnly }) => ({
      fromFile,
      toFile,
      fromModule,
      toModule,
      typeOnly,
    }));
};

const isOversized = (
  module: ModuleRecord,
  thresholds: ArchitectureConfig["thresholds"],
): boolean =>
  !["entrypoint", "barrel"].includes(module.kind) &&
  (module.fileCount > thresholds.oversized_module_files ||
    module.exportedSymbolCount > thresholds.oversized_module_exports);

const moduleEvidence = (module: ModuleRecord): string[] => [
  `module ${module.id}: ${module.fileCount} files, ${module.exportedSymbolCount} exports`,
];

const severityRank: Record<GrowthModeFinding["severity"], number> = {
  block: 0,
  warn: 1,
  info: 2,
};

const sortedFindings = (findings: GrowthModeFinding[]): GrowthModeFinding[] =>
  findings.sort((left, right) =>
    binaryCompare(
      `${severityRank[left.severity]}\0${left.ruleId}\0${left.id}`,
      `${severityRank[right.severity]}\0${right.ruleId}\0${right.id}`,
    ),
  );

export const sanitizeAnalysisWarning = (
  warning: string,
  projectRoot: string,
): string =>
  warning
    .replaceAll(projectRoot, ".")
    .replaceAll(projectRoot.replaceAll("/", "\\"), ".")
    .replace(
      /(?<![A-Za-z0-9._-])[A-Za-z]:[\\/](?:[^\s:;,)'"\\/]+[\\/]?)+/gu,
      "<absolute-path>",
    )
    .replace(
      /(?<![:/A-Za-z0-9._-])\/(?:[^/\s:;,)'"]+\/?)+/gu,
      "<absolute-path>",
    );

export const compareGrowth = (
  input: GrowthComparisonInput,
): GrowthComparisonResult => {
  const findings: GrowthModeFinding[] = [];
  const baselineCycles = new Map(
    input.baseline.repository.cycles.map((cycle) => [cycleKey(cycle), cycle]),
  );
  const currentCycles = new Map(
    input.current.repository.cycles.map((cycle) => [cycleKey(cycle), cycle]),
  );

  for (const [key, cycle] of currentCycles) {
    if (baselineCycles.has(key)) continue;
    const files = canonicalCycleValues(cycle.files);
    const blocking =
      input.config.growthMode.enforcement === "block" &&
      input.config.growthMode.blockOn.includes("new-cycle");
    findings.push(
      canonicalFinding({
        ruleId: "new-cycle",
        severity: blocking ? "block" : "warn",
        title: `New dependency cycle: ${files.join(" → ")}`,
        files: cycle.files,
        symbols: [],
        edges: evidenceEdges(cycle, input.current.repository.imports),
        baselineEvidence: ["This cycle was absent from the session baseline."],
        currentEvidence: [
          `Cycle contains ${cycle.files.length} file${cycle.files.length === 1 ? "" : "s"}.`,
        ],
        consequence:
          "The change introduces a dependency cycle after the session baseline.",
        suggestions: [
          "Reverse or remove the new dependency edge.",
          "Move the shared contract to an existing lower-level module.",
        ],
      }),
    );
  }

  for (const [key, cycle] of baselineCycles) {
    if (currentCycles.has(key)) continue;
    const files = canonicalCycleValues(cycle.files);
    findings.push(
      canonicalFinding({
        ruleId: "pre-existing-issue-removed",
        severity: "info",
        title: `Dependency cycle removed: ${files.join(" → ")}`,
        files: cycle.files,
        symbols: [],
        edges: evidenceEdges(cycle, input.baseline.repository.imports),
        baselineEvidence: ["The cycle existed in the session baseline."],
        currentEvidence: ["The cycle is absent from the current architecture."],
        consequence: "The current change improves the dependency graph.",
        suggestions: ["Keep the cycle removed."],
      }),
    );
  }

  const baselineModules = new Map(
    input.baseline.repository.modules.map((module) => [module.id, module]),
  );
  const currentModules = new Map(
    input.current.repository.modules.map((module) => [module.id, module]),
  );
  for (const module of currentModules.values()) {
    const baseline = baselineModules.get(module.id);
    const baselineOversized =
      baseline !== undefined &&
      isOversized(baseline, input.baseline.thresholds);
    const currentOversized = isOversized(module, input.config.thresholds);
    if (
      currentOversized &&
      !baselineOversized &&
      input.config.growthMode.warnOn.includes("oversized-threshold-crossed")
    )
      findings.push(
        canonicalFinding({
          ruleId: "oversized-threshold-crossed",
          severity: "warn",
          title: `Module ${module.id} crossed an oversized threshold`,
          files: module.paths,
          symbols: [],
          edges: [],
          baselineEvidence: baseline
            ? moduleEvidence(baseline)
            : [`module ${module.id} did not exist in the baseline`],
          currentEvidence: moduleEvidence(module),
          consequence:
            "The module became oversized after the session baseline.",
          suggestions: [
            "Keep the module below the configured file or export threshold.",
          ],
        }),
      );
    else if (
      currentOversized &&
      baselineOversized &&
      baseline !== undefined &&
      (module.fileCount > baseline.fileCount ||
        module.exportedSymbolCount > baseline.exportedSymbolCount) &&
      input.config.growthMode.warnOn.includes("oversized-module-growth")
    )
      findings.push(
        canonicalFinding({
          ruleId: "oversized-module-growth",
          severity: "warn",
          title: `Oversized module ${module.id} grew`,
          files: module.paths,
          symbols: [],
          edges: [],
          baselineEvidence: moduleEvidence(baseline),
          currentEvidence: moduleEvidence(module),
          consequence: "An already oversized module gained files or exports.",
          suggestions: [
            "Place the new responsibility in an existing smaller module.",
          ],
        }),
      );
  }

  for (const baseline of baselineModules.values()) {
    const current = currentModules.get(baseline.id);
    if (
      isOversized(baseline, input.baseline.thresholds) &&
      (current === undefined || !isOversized(current, input.config.thresholds))
    )
      findings.push(
        canonicalFinding({
          ruleId: "pre-existing-issue-removed",
          severity: "info",
          title: `Oversized module improved: ${baseline.id}`,
          files: current?.paths ?? baseline.paths,
          symbols: [],
          edges: [],
          baselineEvidence: moduleEvidence(baseline),
          currentEvidence: current
            ? moduleEvidence(current)
            : [`module ${baseline.id} is absent from the current architecture`],
          consequence:
            "The current architecture removes a baseline oversized-module issue.",
          suggestions: ["Preserve the improvement."],
        }),
      );
  }

  const baselineWarnings = new Set(
    input.baseline.warnings.map((warning) =>
      sanitizeAnalysisWarning(warning, input.baseline.repository.projectRoot),
    ),
  );
  const newWarnings = [
    ...new Set(
      input.current.warnings.map((warning) =>
        sanitizeAnalysisWarning(warning, input.current.repository.projectRoot),
      ),
    ),
  ].filter((warning) => !baselineWarnings.has(warning));
  if (newWarnings.length > 0)
    findings.push(
      canonicalFinding({
        ruleId: "analysis-incomplete",
        severity: "warn",
        title: "Architecture analysis is incomplete",
        files: [],
        symbols: [],
        edges: [],
        baselineEvidence: [
          `${baselineWarnings.size} analyzer warning${baselineWarnings.size === 1 ? "" : "s"} at baseline.`,
        ],
        currentEvidence: newWarnings,
        consequence:
          "Braid cannot claim a complete architecture result for this change.",
        suggestions: [
          "Resolve the reported parse or source-discovery warning.",
        ],
      }),
    );

  const allFindings = sortedFindings(findings);
  const affected = new Set(input.changedPaths);
  const changed = new Set(input.changedPaths);
  for (const repository of [
    input.baseline.repository,
    input.current.repository,
  ])
    for (const edge of repository.imports)
      if (edge.kind === "internal" && changed.has(edge.toFile))
        affected.add(edge.fromFile);
  for (const finding of allFindings)
    for (const filePath of finding.files) affected.add(filePath);

  const selected = allFindings.slice(0, input.config.growthMode.maxFindings);
  const status: GrowthModeReportStatus = selected.some(
    ({ severity }) => severity === "block",
  )
    ? "block"
    : selected.some(({ severity }) => severity === "warn")
      ? "warn"
      : "pass";
  return {
    status,
    findings: selected,
    affectedPaths: [...affected].sort(),
  };
};
