import type { ReversibilityAssessment } from "@braid/core";
import type { ProposalCandidate } from "../candidate.js";

export const classifyReversibility = (
  candidate: ProposalCandidate,
): ReversibilityAssessment => {
  if (
    candidate.protectedFiles.length > 0 ||
    candidate.affectedFiles.length > 10 ||
    candidate.affectedModules.length > 3
  )
    return {
      level: "difficult",
      factors: [
        ...(candidate.protectedFiles.length > 0
          ? ["Protected paths require an explicit reverse migration."]
          : []),
        ...(candidate.affectedFiles.length > 10
          ? ["Rollback spans more than 10 files."]
          : []),
        ...(candidate.affectedModules.length > 3
          ? ["Rollback spans more than 3 modules."]
          : []),
      ],
    };

  if (
    candidate.publicEntrypoints.length > 0 ||
    candidate.affectedModules.length > 1 ||
    candidate.target.type === "break-cycle"
  )
    return {
      level: "conditional",
      factors: [
        ...(candidate.publicEntrypoints.length > 0
          ? ["Compatibility exports may need restoration."]
          : []),
        ...(candidate.affectedModules.length > 1
          ? ["Rollback must restore dependencies across multiple modules."]
          : []),
        ...(candidate.target.type === "break-cycle"
          ? ["The original module edge must be restored safely."]
          : []),
      ],
    };

  return {
    level: "easy",
    factors: [
      "The proposal is bounded to one module and an isolated file set.",
    ],
  };
};
