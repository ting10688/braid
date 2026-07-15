import type { MigrationProposal } from "@braid/core";

export const rankProposals = (
  proposals: readonly MigrationProposal[],
): MigrationProposal[] =>
  [...proposals].sort(
    (left, right) =>
      right.ranking.severity - left.ranking.severity ||
      right.ranking.confidence - left.ranking.confidence ||
      right.ranking.expectedBenefit - left.ranking.expectedBenefit ||
      left.ranking.riskPenalty - right.ranking.riskPenalty ||
      left.affectedFiles.length - right.affectedFiles.length ||
      left.type.localeCompare(right.type) ||
      left.id.localeCompare(right.id),
  );
