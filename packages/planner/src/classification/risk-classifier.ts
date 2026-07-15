import type { RiskAssessment, RiskFactor } from "@braid/core";
import type { ProposalCandidate } from "../candidate.js";

export const classifyRisk = (candidate: ProposalCandidate): RiskAssessment => {
  const factors: RiskFactor[] = [];
  const add = (
    type: RiskFactor["type"],
    points: number,
    details: string,
  ): void => {
    factors.push({ type, points, details });
  };

  if (candidate.affectedFiles.length > 5)
    add("affected-files-over-5", 1, "Affects more than 5 files.");
  if (candidate.affectedFiles.length > 10)
    add("affected-files-over-10", 2, "Affects more than 10 files.");
  if (candidate.affectedModules.length > 2)
    add("modules-over-2", 1, "Spans more than 2 modules.");
  if (candidate.publicEntrypoints.length > 0)
    add(
      "public-entrypoint",
      2,
      `Touches public entrypoints: ${candidate.publicEntrypoints.join(", ")}.`,
    );
  if (candidate.moduleSurfaceFiles.length > 0)
    add(
      "module-surface",
      1,
      `Touches entrypoint or barrel modules: ${candidate.moduleSurfaceFiles.join(", ")}.`,
    );
  if (candidate.protectedFiles.length > 0)
    add(
      "protected-path",
      5,
      `Touches protected paths: ${candidate.protectedFiles.join(", ")}.`,
    );
  if ((candidate.cycleLength ?? 0) > 2)
    add("long-cycle", 1, "Modifies an edge in a cycle longer than 2 modules.");
  if (candidate.confidence < 2)
    add("low-confidence", 1, "Evidence confidence is below 2 of 3.");
  if (
    candidate.target.type === "break-cycle" &&
    candidate.target.suggestedStrategy !== "introduce-boundary"
  )
    add(
      "new-public-contract",
      1,
      "The suggested strategy may require a new public contract.",
    );

  factors.sort((left, right) =>
    `${left.type}\0${left.details}`.localeCompare(
      `${right.type}\0${right.details}`,
    ),
  );
  const points = factors.reduce((total, factor) => total + factor.points, 0);
  return {
    level: points <= 1 ? "low" : points <= 4 ? "medium" : "high",
    points,
    factors,
  };
};
