import {
  architectureConfigSchema,
  architectureSnapshotSchema,
  migrationProposalSchema,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type MigrationProposal,
  type ProposalAlternative,
  type ProposalType,
} from "@braid/core";
import type { ProposalCandidate } from "./candidate.js";
import { breakCycleCandidates } from "./candidates/break-cycle-candidate.js";
import { extractModuleCandidates } from "./candidates/extract-module-candidate.js";
import { classifyReversibility } from "./classification/reversibility-classifier.js";
import { classifyRisk } from "./classification/risk-classifier.js";
import { createProposalId } from "./proposal-id.js";
import { rankProposals } from "./ranking/proposal-ranker.js";

export interface GenerateProposalOptions {
  type?: ProposalType;
  limit?: number;
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);

const cycleReduction = (proposal: MigrationProposal): number =>
  proposal.expectedImpact.simulated.find(
    ({ metric }) => metric === "circularDependencies",
  )?.delta ?? 0;

const edgeImportCount = (proposal: MigrationProposal): number => {
  const evidence = proposal.evidence.find(({ type }) => type === "cycle-edge");
  return evidence?.type === "cycle-edge"
    ? evidence.importCount
    : Number.MAX_SAFE_INTEGER;
};

const reversibilityRank = (proposal: MigrationProposal): number =>
  ({ easy: 0, conditional: 1, difficult: 2 })[proposal.reversibility.level];

const selectedEdgeTouches = (
  proposal: MigrationProposal,
  evidenceType: "public-entrypoint-impact" | "protected-path-impact",
): boolean => {
  if (proposal.target.type !== "break-cycle") return false;
  const selected = new Set(proposal.target.selectedEdge.files);
  return proposal.evidence.some(
    (evidence) =>
      evidence.type === evidenceType &&
      evidence.files.some((file) => selected.has(file)),
  );
};

const compareCycleActions = (
  left: MigrationProposal,
  right: MigrationProposal,
): number => {
  if (left.target.type !== "break-cycle" || right.target.type !== "break-cycle")
    return compare(left.id, right.id);
  return (
    cycleReduction(left) - cycleReduction(right) ||
    left.affectedFiles.length - right.affectedFiles.length ||
    edgeImportCount(left) - edgeImportCount(right) ||
    Number(selectedEdgeTouches(left, "public-entrypoint-impact")) -
      Number(selectedEdgeTouches(right, "public-entrypoint-impact")) ||
    Number(selectedEdgeTouches(left, "protected-path-impact")) -
      Number(selectedEdgeTouches(right, "protected-path-impact")) ||
    left.risk.points - right.risk.points ||
    reversibilityRank(left) - reversibilityRank(right) ||
    compare(
      `${left.target.selectedEdge.fromModule}\0${left.target.selectedEdge.toModule}`,
      `${right.target.selectedEdge.fromModule}\0${right.target.selectedEdge.toModule}`,
    )
  );
};

const cycleActionKey = (proposal: MigrationProposal): string => {
  if (proposal.target.type !== "break-cycle") return proposal.id;
  const { selectedEdge, suggestedStrategy } = proposal.target;
  return `${suggestedStrategy}\0${selectedEdge.fromModule}\0${selectedEdge.toModule}\0${[...selectedEdge.files].sort(compare).join("\0")}`;
};

const compareEquivalentActions = (
  left: MigrationProposal,
  right: MigrationProposal,
): number =>
  left.affectedModules.length - right.affectedModules.length ||
  left.affectedFiles.length - right.affectedFiles.length ||
  compareCycleActions(left, right);

const alternativeFrom = (proposal: MigrationProposal): ProposalAlternative => {
  if (proposal.target.type !== "break-cycle")
    throw new Error("Only cycle proposals can become cycle alternatives");
  return {
    strategy: proposal.target.suggestedStrategy,
    selectedEdge: proposal.target.selectedEdge,
    affectedFiles: proposal.affectedFiles,
    affectedModules: proposal.affectedModules,
    rationale:
      proposal.expectedImpact.simulated[0]?.rationale ?? proposal.summary,
    evidence: proposal.evidence,
    expectedImpact: proposal.expectedImpact,
    risk: proposal.risk,
    reversibility: proposal.reversibility,
  };
};

export const groupCycleProposals = (
  proposals: readonly MigrationProposal[],
): MigrationProposal[] => {
  const other = proposals.filter(({ type }) => type !== "break-cycle");
  const grouped = new Map<string, MigrationProposal[]>();
  for (const proposal of proposals.filter(
    ({ type }) => type === "break-cycle",
  )) {
    if (proposal.target.type !== "break-cycle") continue;
    const signature = proposal.target.rootCauseSignature ?? proposal.id;
    const group = grouped.get(signature) ?? [];
    group.push(proposal);
    grouped.set(signature, group);
  }

  const cycleProposals = [...grouped.values()].map((group) => {
    const unique = new Map<string, MigrationProposal>();
    for (const proposal of [...group].sort(compareEquivalentActions))
      if (!unique.has(cycleActionKey(proposal)))
        unique.set(cycleActionKey(proposal), proposal);
    const [primary, ...remaining] = [...unique.values()].sort(
      compareCycleActions,
    );
    if (!primary) throw new Error("Cycle root has no actionable proposal");
    const alternatives = remaining
      .map(alternativeFrom)
      .sort((left, right) =>
        compare(
          `${left.selectedEdge.fromModule}\0${left.selectedEdge.toModule}\0${left.strategy}`,
          `${right.selectedEdge.fromModule}\0${right.selectedEdge.toModule}\0${right.strategy}`,
        ),
      );
    return migrationProposalSchema.parse({
      ...primary,
      ...(alternatives.length > 0 ? { alternatives } : {}),
    });
  });
  return [...other, ...cycleProposals];
};

const proposalFromCandidate = (
  snapshot: ArchitectureSnapshot,
  config: ArchitectureConfig,
  candidate: ProposalCandidate,
): MigrationProposal => {
  const id = createProposalId(
    snapshot,
    config,
    candidate.type,
    candidate.target,
    candidate.affectedFiles,
    candidate.affectedModules,
  );
  const risk = classifyRisk(candidate);
  const reversibility = classifyReversibility(candidate);
  return migrationProposalSchema.parse({
    schemaVersion: candidate.schemaVersion,
    id,
    snapshotId: candidate.snapshotId,
    type: candidate.type,
    title: candidate.title,
    summary: candidate.summary,
    affectedFiles: [...candidate.affectedFiles].sort(),
    affectedModules: [...candidate.affectedModules].sort(),
    target: candidate.target,
    evidence: candidate.evidence,
    expectedImpact: candidate.expectedImpact,
    risk,
    reversibility,
    preconditions: [...candidate.preconditions].sort(),
    constraints: [...candidate.constraints].sort(),
    rollbackStrategy: candidate.rollbackStrategy,
    ranking: {
      severity: candidate.severity,
      confidence: candidate.confidence,
      expectedBenefit: candidate.expectedBenefit,
      riskPenalty: risk.points,
      deterministicTieBreaker: id,
    },
  });
};

export const generateMigrationProposals = (
  snapshotInput: ArchitectureSnapshot,
  configInput: ArchitectureConfig,
  options: GenerateProposalOptions = {},
): MigrationProposal[] => {
  const snapshot = architectureSnapshotSchema.parse(snapshotInput);
  const config = architectureConfigSchema.parse(configInput);
  const enabled = config.planner.enabled_proposals.filter(
    (type) => !options.type || type === options.type,
  );
  const candidates = [
    ...(enabled.includes("break-cycle")
      ? breakCycleCandidates(snapshot, config)
      : []),
    ...(enabled.includes("extract-module")
      ? extractModuleCandidates(snapshot, config)
      : []),
  ];
  const ranked = rankProposals(
    groupCycleProposals(
      candidates.map((candidate) =>
        proposalFromCandidate(snapshot, config, candidate),
      ),
    ),
  ).filter(
    (proposal) =>
      config.planner.include_high_risk || proposal.risk.level !== "high",
  );
  const requestedLimit = options.limit ?? config.planner.max_proposals;
  const limit = Math.max(
    0,
    Math.min(requestedLimit, config.planner.max_proposals),
  );
  return ranked.slice(0, limit);
};
