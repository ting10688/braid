import type {
  ExpectedImpact,
  ProposalEvidence,
  ProposalTarget,
  ProposalType,
} from "@braid/core";

export interface ProposalCandidate {
  schemaVersion: 1;
  snapshotId: string;
  type: ProposalType;
  title: string;
  summary: string;
  affectedFiles: string[];
  affectedModules: string[];
  target: ProposalTarget;
  evidence: ProposalEvidence[];
  expectedImpact: ExpectedImpact;
  preconditions: string[];
  constraints: string[];
  rollbackStrategy: string;
  severity: number;
  confidence: number;
  expectedBenefit: number;
  protectedFiles: string[];
  publicEntrypoints: string[];
  cycleLength?: number;
}
