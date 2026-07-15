import type { MigrationProposal } from "@braid/core";

const evidenceLine = (proposal: MigrationProposal): string => {
  const evidence = proposal.evidence[0]!;
  if (evidence.type === "dependency-cycle")
    return `Module cycle: ${evidence.modules.join(" → ")} → ${evidence.modules[0]}`;
  if (evidence.type === "oversized-file")
    return `Oversized file: ${evidence.actualLines} lines (threshold ${evidence.thresholdLines})`;
  return evidence.type;
};

const targetLine = (proposal: MigrationProposal): string =>
  proposal.target.type === "extract-module"
    ? `Candidate symbols: ${proposal.target.candidateSymbols.join(", ")}`
    : `Selected edge: ${proposal.target.selectedEdge.fromModule} → ${proposal.target.selectedEdge.toModule}`;

const impactLine = (proposal: MigrationProposal): string => {
  const simulated = proposal.expectedImpact.simulated[0];
  const observation = simulated ?? proposal.expectedImpact.estimated[0];
  if (!observation) return "Expected impact: unknown";
  const delta =
    observation.delta === undefined ? "" : ` (${observation.delta})`;
  return `Expected impact (${simulated ? "simulated" : "estimated"}): ${observation.metric} ${observation.direction}${delta}`;
};

export const formatProposalReport = (
  projectRoot: string,
  snapshotId: string,
  proposals: readonly MigrationProposal[],
): string => {
  const lines = [
    "Braid migration proposals",
    "",
    `Project: ${projectRoot}`,
    `Snapshot: ${snapshotId}`,
    `Proposals: ${proposals.length}`,
  ];
  if (proposals[0])
    lines.push("", `Recommended first candidate: ${proposals[0].id}`);
  proposals.forEach((proposal, index) => {
    lines.push(
      "",
      `${index + 1}. [${proposal.type}] ${proposal.title}`,
      `   ID: ${proposal.id}`,
      `   Risk: ${proposal.risk.level}`,
      `   Reversibility: ${proposal.reversibility.level}`,
      `   Affected modules: ${proposal.affectedModules.join(", ")}`,
      `   Affected files: ${proposal.affectedFiles.length}`,
      `   Evidence: ${evidenceLine(proposal)}`,
      `   ${impactLine(proposal)}`,
      `   ${targetLine(proposal)}`,
    );
  });
  return lines.join("\n");
};
