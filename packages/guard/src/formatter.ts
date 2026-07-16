import type { GrowthModeReport } from "@braid/core";

const bounded = (value: string, maximum: number): string =>
  value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;

export interface GrowthModeBaselineSummary {
  cycles: number;
  oversizedModules: number;
  analyzerWarnings: number;
}

const counted = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

export const formatGrowthContext = (
  report: GrowthModeReport,
  maximumCharacters: number,
  baseline?: GrowthModeBaselineSummary,
): string => {
  if (report.skippedReason === "growth-mode-disabled")
    return bounded(
      "Braid Growth Mode is disabled by repository configuration. Live architecture feedback and Stop enforcement are inactive.",
      maximumCharacters,
    );
  return bounded(
    [
      `Braid Growth Mode baseline ${report.baseline.id} is active for this session and worktree.`,
      ...(baseline
        ? [
            `Pre-existing baseline: ${counted(baseline.cycles, "dependency cycle")}, ${counted(baseline.oversizedModules, "oversized module")}, and ${counted(baseline.analyzerWarnings, "analyzer warning")}.`,
          ]
        : []),
      "Only architecture regressions introduced after this baseline are reported; pre-existing issues do not block completion.",
      `Current status: ${report.status}.`,
    ].join(" "),
    maximumCharacters,
  );
};

export const formatGrowthFeedback = (
  report: GrowthModeReport,
  maximumCharacters: number,
): string => {
  if (report.skippedReason === "growth-mode-disabled")
    return bounded(
      "Braid Growth Mode: DISABLED — live architecture feedback and Stop enforcement are inactive.",
      maximumCharacters,
    );
  const lines = [`Braid Growth Mode: ${report.status.toUpperCase()}`];
  for (const finding of report.findings) {
    lines.push(`- [${finding.severity}] ${finding.title}`);
    if (finding.files.length > 0)
      lines.push(`  Files: ${finding.files.join(", ")}`);
    lines.push(`  ${finding.consequence}`);
    for (const suggestion of finding.suggestions)
      lines.push(`  Suggestion: ${suggestion}`);
  }
  return bounded(lines.join("\n"), maximumCharacters);
};

export const formatGrowthModeReport = (
  report: GrowthModeReport,
  maximumCharacters = 4_000,
): string => formatGrowthFeedback(report, maximumCharacters);
