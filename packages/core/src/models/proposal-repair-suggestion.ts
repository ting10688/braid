import { z } from "zod";
import {
  executionReadinessStateSchema,
  executionReadinessSymbolLocatorSchema,
  executionReadinessSymbolSchema,
  externalDependencySchema,
  predictedCycleRiskSchema,
  predictedImportEdgeSchema,
  readinessReasonSchema,
  readinessWarningSchema,
  retainedDependencySchema,
  unresolvedDependencySchema,
} from "./execution-readiness.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const PROPOSAL_REPAIR_SUGGESTION_SCHEMA_VERSION = "1.0.0";

export const proposalRepairSuggestionStateSchema = z.enum([
  "actionable",
  "partial",
  "unavailable",
]);

export const proposalRepairSuggestedAdditionSchema = z.object({
  symbol: executionReadinessSymbolSchema,
  rationale: z.string().min(1),
  omissionReadinessState: executionReadinessStateSchema,
  omissionBlockingReasons: z.array(readinessReasonSchema),
});

export const proposalRepairSafeImportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("internal"),
    dependency: retainedDependencySchema,
  }),
  z.object({
    kind: z.literal("external"),
    dependency: externalDependencySchema,
  }),
]);

export const proposalRepairSuggestionSchema = z
  .object({
    schemaVersion: z.literal(PROPOSAL_REPAIR_SUGGESTION_SCHEMA_VERSION),
    suggestionId: z.string().regex(/^RS-[a-f0-9]{16}$/u),
    baseProposalId: z.string().regex(/^P-EM-[a-f0-9]{8}$/u),
    fingerprints: z.object({
      baseProposal: sha256Schema,
      snapshot: sha256Schema,
      configuration: sha256Schema,
      source: sha256Schema,
    }),
    state: proposalRepairSuggestionStateSchema,
    currentReadinessState: executionReadinessStateSchema,
    predictedReadinessState: executionReadinessStateSchema.nullable(),
    primarySymbols: z.array(executionReadinessSymbolSchema),
    currentApprovedCompanionSymbols: z.array(
      executionReadinessSymbolLocatorSchema,
    ),
    suggestedCompanionSymbolAdditions: z.array(
      proposalRepairSuggestedAdditionSchema,
    ),
    minimization: z.object({
      candidateSymbols: z.array(executionReadinessSymbolLocatorSchema),
      eliminatedSymbols: z.array(executionReadinessSymbolLocatorSchema),
    }),
    retainedDependencies: z.array(retainedDependencySchema),
    safelyImportedDependencies: z.array(proposalRepairSafeImportSchema),
    unresolvedDependencies: z.array(unresolvedDependencySchema),
    predictedImportEdges: z.array(predictedImportEdgeSchema),
    predictedCycleRisks: z.array(predictedCycleRiskSchema),
    remainingBlockers: z.array(readinessReasonSchema),
    warnings: z.array(readinessWarningSchema),
    reevaluation: z.object({
      performed: z.boolean(),
      resultHash: sha256Schema.nullable(),
      stable: z.boolean(),
    }),
    minimal: z.boolean(),
    advisory: z.literal(true),
    deterministicEvidence: z.object({
      algorithmVersion: z.literal("1.0.0"),
      semanticHash: sha256Schema,
      repeatedSemanticHash: sha256Schema,
      stable: z.boolean(),
    }),
  })
  .superRefine((suggestion, context) => {
    const issue = (path: Array<string | number>, message: string): void =>
      context.addIssue({ code: "custom", path, message });
    const additions = suggestion.suggestedCompanionSymbolAdditions.length;

    if (suggestion.state !== "unavailable" && additions === 0)
      issue(
        ["suggestedCompanionSymbolAdditions"],
        `${suggestion.state} suggestion requires at least one addition`,
      );
    if (suggestion.state === "unavailable" && additions > 0)
      issue(
        ["suggestedCompanionSymbolAdditions"],
        "unavailable suggestion cannot recommend additions",
      );
    if (
      suggestion.state === "unavailable" &&
      (suggestion.minimization.candidateSymbols.length > 0 ||
        suggestion.minimization.eliminatedSymbols.length > 0)
    )
      issue(
        ["minimization"],
        "unavailable suggestion cannot claim minimization evidence",
      );
    const candidateKeys = new Set(
      suggestion.minimization.candidateSymbols.map(
        ({ file, name }) => `${file}\0${name}`,
      ),
    );
    if (
      suggestion.minimization.eliminatedSymbols.some(
        ({ file, name }) => !candidateKeys.has(`${file}\0${name}`),
      )
    )
      issue(
        ["minimization", "eliminatedSymbols"],
        "eliminated symbols must come from the candidate set",
      );
    if (
      suggestion.state !== "unavailable" &&
      suggestion.currentReadinessState !== "not-ready"
    )
      issue(
        ["currentReadinessState"],
        "repair suggestions apply only to not-ready proposals",
      );
    if (
      suggestion.state === "actionable" &&
      !["ready", "ready-with-warnings"].includes(
        suggestion.predictedReadinessState ?? "",
      )
    )
      issue(
        ["predictedReadinessState"],
        "actionable suggestion must predict an executable readiness state",
      );
    if (
      suggestion.state === "actionable" &&
      suggestion.remainingBlockers.length > 0
    )
      issue(
        ["remainingBlockers"],
        "actionable suggestion cannot retain blockers",
      );
    if (
      suggestion.state === "partial" &&
      (suggestion.predictedReadinessState !== "not-ready" ||
        suggestion.remainingBlockers.length === 0)
    )
      issue(
        ["remainingBlockers"],
        "partial suggestion must remain not-ready with blockers",
      );
    if (
      suggestion.state === "unavailable" &&
      suggestion.predictedReadinessState !== null
    )
      issue(
        ["predictedReadinessState"],
        "unavailable suggestion cannot claim predicted readiness",
      );
    if (suggestion.minimal !== (suggestion.state === "actionable"))
      issue(["minimal"], "only actionable suggestions may claim minimality");
    if (
      suggestion.state === "actionable" &&
      (!suggestion.reevaluation.performed || !suggestion.reevaluation.stable)
    )
      issue(
        ["reevaluation"],
        "actionable suggestion requires stable in-memory reevaluation",
      );
    if (
      !suggestion.deterministicEvidence.stable &&
      suggestion.state !== "unavailable"
    )
      issue(
        ["deterministicEvidence", "stable"],
        "unstable suggestion evidence must be unavailable",
      );
  });

export type ProposalRepairSuggestionState = z.infer<
  typeof proposalRepairSuggestionStateSchema
>;
export type ProposalRepairSuggestedAddition = z.infer<
  typeof proposalRepairSuggestedAdditionSchema
>;
export type ProposalRepairSafeImport = z.infer<
  typeof proposalRepairSafeImportSchema
>;
export type ProposalRepairSuggestion = z.infer<
  typeof proposalRepairSuggestionSchema
>;
