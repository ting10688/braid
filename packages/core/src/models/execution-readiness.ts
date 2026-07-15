import { z } from "zod";
import { projectRelativePathSchema } from "./migration-proposal.js";
import { topLevelDeclarationRecordSchema } from "./repository-model.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const executionReadinessStateSchema = z.enum([
  "ready",
  "ready-with-warnings",
  "not-ready",
]);

export const executionReadinessSymbolLocatorSchema = z.object({
  file: projectRelativePathSchema,
  name: z.string().min(1),
});

export const executionReadinessSymbolSchema =
  executionReadinessSymbolLocatorSchema.extend({
    kind: topLevelDeclarationRecordSchema.shape.kind,
    module: z.string().min(1),
    exported: z.boolean(),
  });

export const retainedDependencySchema = z.object({
  symbol: executionReadinessSymbolSchema,
  referencedBy: z.array(executionReadinessSymbolLocatorSchema).min(1),
});

export const externalDependencySchema = z.object({
  name: z.string().min(1),
  package: z.string().min(1),
  referencedBy: z.array(executionReadinessSymbolLocatorSchema).min(1),
});

export const unresolvedDependencySchema = z.object({
  name: z.string().min(1),
  referencedBy: z.array(executionReadinessSymbolLocatorSchema).min(1),
  reason: z.string().min(1),
});

export const predictedImportEdgeSchema = z.object({
  fromModule: z.string().min(1),
  toModule: z.string().min(1),
  reason: z.enum(["moved-symbol-reference", "retained-dependency"]),
  symbols: z.array(z.string().min(1)).min(1),
});

export const predictedCycleRiskSchema = z.object({
  modules: z.array(z.string().min(1)).min(2),
  edges: z.array(predictedImportEdgeSchema).min(1),
});

export const readinessReasonCodeSchema = z.enum([
  "primary-symbol-unresolved",
  "required-local-declaration-unresolved",
  "predictable-reverse-dependency",
  "predicted-cycle",
  "companion-not-authorized",
  "closure-file-budget-exceeded",
  "closure-symbol-budget-exceeded",
  "protected-companion",
  "public-entrypoint-companion",
  "nondeterministic-closure",
]);

export const readinessWarningCodeSchema = z.enum([
  "approved-companion-not-required",
  "legacy-reference-evidence",
  "retained-local-dependency",
]);

export const readinessReasonSchema = z.object({
  code: readinessReasonCodeSchema,
  message: z.string().min(1),
  files: z.array(projectRelativePathSchema),
  symbols: z.array(z.string().min(1)),
});

export const readinessWarningSchema = z.object({
  code: readinessWarningCodeSchema,
  message: z.string().min(1),
  files: z.array(projectRelativePathSchema),
  symbols: z.array(z.string().min(1)),
});

export const executionReadinessResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().regex(/^P-EM-[a-f0-9]{8}$/u),
    fingerprints: z.object({
      snapshotId: z.string().min(1),
      configHash: sha256Schema,
      sourceFingerprint: sha256Schema,
    }),
    state: executionReadinessStateSchema,
    primarySymbols: z.array(executionReadinessSymbolSchema),
    requiredCompanionSymbols: z.array(executionReadinessSymbolSchema),
    retainedDependencies: z.array(retainedDependencySchema),
    externalDependencies: z.array(externalDependencySchema),
    unresolvedDependencies: z.array(unresolvedDependencySchema),
    predictedImportEdges: z.array(predictedImportEdgeSchema),
    predictedCycleRisks: z.array(predictedCycleRiskSchema),
    warnings: z.array(readinessWarningSchema),
    deterministicEvidence: z.object({
      algorithmVersion: z.literal("1.0.0"),
      inputHash: sha256Schema,
      firstResultHash: sha256Schema,
      repeatedResultHash: sha256Schema,
      stable: z.boolean(),
    }),
    blockingReasons: z.array(readinessReasonSchema),
  })
  .superRefine((result, context) => {
    const issue = (path: string[], message: string): void =>
      context.addIssue({ code: "custom", path, message });
    if (result.state === "not-ready" && result.blockingReasons.length === 0)
      issue(
        ["blockingReasons"],
        "not-ready result requires at least one blocking reason",
      );
    if (result.state !== "not-ready" && result.blockingReasons.length > 0)
      issue(
        ["blockingReasons"],
        "ready result cannot contain blocking reasons",
      );
    if (result.state === "ready" && result.warnings.length > 0)
      issue(["warnings"], "ready result cannot contain warnings");
    if (result.state === "ready-with-warnings" && result.warnings.length === 0)
      issue(
        ["warnings"],
        "ready-with-warnings result requires at least one warning",
      );
    if (
      !result.deterministicEvidence.stable &&
      !result.blockingReasons.some(
        ({ code }) => code === "nondeterministic-closure",
      )
    )
      issue(
        ["deterministicEvidence", "stable"],
        "unstable evidence requires a nondeterministic-closure blocker",
      );
  });

export type ExecutionReadinessState = z.infer<
  typeof executionReadinessStateSchema
>;
export type ExecutionReadinessSymbolLocator = z.infer<
  typeof executionReadinessSymbolLocatorSchema
>;
export type ExecutionReadinessSymbol = z.infer<
  typeof executionReadinessSymbolSchema
>;
export type RetainedDependency = z.infer<typeof retainedDependencySchema>;
export type ExternalDependency = z.infer<typeof externalDependencySchema>;
export type UnresolvedDependency = z.infer<typeof unresolvedDependencySchema>;
export type PredictedImportEdge = z.infer<typeof predictedImportEdgeSchema>;
export type PredictedCycleRisk = z.infer<typeof predictedCycleRiskSchema>;
export type ReadinessReason = z.infer<typeof readinessReasonSchema>;
export type ReadinessWarning = z.infer<typeof readinessWarningSchema>;
export type ExecutionReadinessResult = z.infer<
  typeof executionReadinessResultSchema
>;
