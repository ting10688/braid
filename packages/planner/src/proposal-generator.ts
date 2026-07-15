import {
  architectureConfigSchema,
  architectureSnapshotSchema,
  migrationProposalSchema,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type MigrationProposal,
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
    candidates.map((candidate) =>
      proposalFromCandidate(snapshot, config, candidate),
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
