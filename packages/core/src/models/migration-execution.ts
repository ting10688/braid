import { z } from "zod";
import {
  expectedImpactSchema,
  projectRelativePathSchema,
} from "./migration-proposal.js";
import { executionReadinessResultSchema } from "./execution-readiness.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const safeArgumentSchema = z
  .string()
  .refine((value) => !value.includes("\0") && !/[\r\n]/u.test(value), {
    message: "must not contain NUL or line breaks",
  });
const workingDirectorySchema = z.union([
  z.literal("."),
  projectRelativePathSchema,
]);

export const validationCommandSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  stage: z
    .enum([
      "format-check",
      "typecheck",
      "lint",
      "unit-test",
      "build",
      "custom-safe-check",
    ])
    .default("custom-safe-check"),
  executable: z.string().regex(/^[A-Za-z0-9._+-]+$/u),
  arguments: z.array(safeArgumentSchema).default([]),
  workingDirectory: workingDirectorySchema.default("."),
  timeoutMs: z.number().int().min(1_000).max(900_000).default(120_000),
  required: z.boolean().default(true),
  stdoutLimit: z.number().int().min(1_024).max(1_048_576).default(65_536),
  stderrLimit: z.number().int().min(1_024).max(1_048_576).default(65_536),
});

export const sourceManifestEntrySchema = z.object({
  path: projectRelativePathSchema,
  fileType: z.enum(["file", "symlink"]),
  contentHash: sha256Schema,
  executable: z.boolean(),
});

export const sourceFingerprintSchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal("sha256"),
  hash: sha256Schema,
  entries: z.array(sourceManifestEntrySchema),
});

export const scopeViolationSchema = z.object({
  code: z.enum([
    "unauthorized-path",
    "forbidden-path",
    "changed-file-limit",
    "deleted-file",
    "binary-file",
    "symlink-change",
    "submodule-change",
    "mode-change",
    "dependency-change",
    "public-entrypoint-change",
    "secret-detected",
  ]),
  path: projectRelativePathSchema.optional(),
  message: z.string().min(1),
});

export const migrationExecutionStatusSchema = z.enum([
  "planned",
  "preflight-failed",
  "worktree-created",
  "running",
  "executor-failed",
  "no-changes",
  "scope-violation",
  "validation-failed",
  "needs-review",
  "succeeded",
  "discarded",
]);

export const migrationExecutionPlanSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().regex(/^PL-[a-f0-9]{16}$/u),
  proposalId: z.string().regex(/^P-EM-[a-f0-9]{8}$/u),
  proposalType: z.literal("extract-module"),
  repository: z.object({
    baseCommit: gitCommitSchema,
    sourceFingerprint: sha256Schema,
    configHash: sha256Schema,
    snapshotId: z.string().min(1),
  }),
  approval: z.object({
    requiredProposalId: z.string().regex(/^P-EM-[a-f0-9]{8}$/u),
  }),
  scope: z.object({
    allowedExistingFiles: z.array(projectRelativePathSchema),
    allowedNewFilePatterns: z.array(projectRelativePathSchema),
    allowedTestFiles: z.array(projectRelativePathSchema),
    forbiddenFiles: z.array(projectRelativePathSchema),
    maximumChangedFiles: z.number().int().min(1).max(8),
  }),
  expectedChange: z.object({
    sourceFile: projectRelativePathSchema,
    sourceModule: z.string().min(1),
    suggestedModule: z.string().min(1),
    destinationDirectory: projectRelativePathSchema,
    symbols: z.array(z.string().min(1)).min(2),
    companionSymbols: z
      .array(
        z.object({
          file: projectRelativePathSchema,
          symbol: z.string().min(1),
        }),
      )
      .optional(),
    predictedImpact: expectedImpactSchema,
  }),
  validation: z.object({
    commands: z.array(validationCommandSchema).min(1),
  }),
  executor: z.object({
    kind: z.enum(["codex", "scripted-test"]),
    requestedModel: z.string().min(1).optional(),
    requestedReasoningEffort: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1_000).max(900_000),
    sandbox: z.literal("workspace-write"),
  }),
  readiness: executionReadinessResultSchema.optional(),
});

export const validationResultSchema = z.object({
  commandId: z.string().min(1),
  stage: validationCommandSchema.shape.stage,
  status: z.enum(["passed", "failed", "warning", "timeout"]),
  required: z.boolean(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});

const metricChangeSchema = z.object({
  before: z.number().int().nonnegative(),
  after: z.number().int().nonnegative(),
  delta: z.number().int(),
});

export const migrationArchitectureImpactSchema = z.object({
  selectedSymbolsMoved: z.boolean(),
  sourceModuleChanged: z.boolean(),
  destinationModuleChanged: z.boolean(),
  metrics: z.object({
    internalImports: metricChangeSchema,
    crossModuleImports: metricChangeSchema,
    cycles: metricChangeSchema,
    oversizedFiles: metricChangeSchema,
    oversizedModules: metricChangeSchema,
    publicEntrypoints: metricChangeSchema,
  }),
  newCycles: z.number().int().nonnegative(),
  publicApiChanged: z.boolean(),
  protectedPathViolation: z.boolean(),
  intendedOutcomeAchieved: z.boolean(),
});

export const impactComparisonSchema = z.object({
  predicted: expectedImpactSchema,
  actual: migrationArchitectureImpactSchema,
  mismatches: z.array(z.string().min(1)),
});

export const migrationExecutionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: z.string().regex(/^E-[0-9a-f-]{36}$/u),
    planId: z.string().regex(/^PL-[a-f0-9]{16}$/u),
    proposalId: z.string().regex(/^P-EM-[a-f0-9]{8}$/u),
    status: migrationExecutionStatusSchema,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    baseCommit: gitCommitSchema,
    candidateBranch: z
      .string()
      .regex(/^braid\/exec\/[a-f0-9]{8}$/u)
      .optional(),
    candidateCommit: gitCommitSchema.optional(),
    executor: z.object({
      kind: z.enum(["codex", "scripted-test"]),
      executableVersion: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      reasoningEffort: z.string().min(1).optional(),
      sandbox: z.literal("workspace-write").optional(),
      exitCode: z.number().int().optional(),
      timedOut: z.boolean().optional(),
      usage: z
        .object({
          inputTokens: z.number().int().nonnegative().optional(),
          cachedInputTokens: z.number().int().nonnegative().optional(),
          outputTokens: z.number().int().nonnegative().optional(),
        })
        .optional(),
    }),
    scope: z.object({
      allowedFiles: z.array(projectRelativePathSchema),
      changedFiles: z.array(projectRelativePathSchema),
      addedFiles: z.array(projectRelativePathSchema),
      deletedFiles: z.array(projectRelativePathSchema),
      violations: z.array(scopeViolationSchema),
    }),
    validation: z.array(validationResultSchema),
    architecture: z.object({
      beforeSnapshotId: z.string().min(1),
      afterSnapshotId: z.string().min(1).optional(),
      predictedImpact: expectedImpactSchema,
      actualImpact: migrationArchitectureImpactSchema.optional(),
      comparison: impactComparisonSchema.optional(),
    }),
    fingerprints: z.object({
      mainBefore: sha256Schema,
      mainAfter: sha256Schema.optional(),
      candidateBefore: sha256Schema,
      candidateAfter: sha256Schema.optional(),
      diffHash: sha256Schema.optional(),
    }),
    artifacts: z.object({
      eventLog: projectRelativePathSchema.optional(),
      finalSummary: projectRelativePathSchema.optional(),
      patch: projectRelativePathSchema.optional(),
      validationReport: projectRelativePathSchema.optional(),
    }),
    failure: z
      .object({
        stage: z.string().min(1),
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .optional(),
  })
  .superRefine((record, context) => {
    const unfinished = ["planned", "worktree-created", "running"].includes(
      record.status,
    );
    const failureStatus = [
      "preflight-failed",
      "executor-failed",
      "no-changes",
      "scope-violation",
      "validation-failed",
      "needs-review",
    ].includes(record.status);
    const afterWorktree = !["planned", "preflight-failed"].includes(
      record.status,
    );
    const issue = (path: (string | number)[], message: string): void =>
      context.addIssue({ code: "custom", path, message });

    if (unfinished && record.completedAt)
      issue(["completedAt"], "unfinished execution cannot be completed");
    if (!unfinished && !record.completedAt)
      issue(["completedAt"], "terminal execution requires completion time");
    if (unfinished && record.failure)
      issue(["failure"], "unfinished execution cannot contain a failure");
    if (failureStatus && !record.failure)
      issue(["failure"], "failed execution requires failure details");
    if (afterWorktree && !record.candidateBranch)
      issue(
        ["candidateBranch"],
        "post-worktree execution requires its candidate branch",
      );
    if (record.candidateCommit && !record.candidateBranch)
      issue(
        ["candidateCommit"],
        "candidate commit requires an owned candidate branch",
      );

    if (record.status !== "succeeded") return;
    if (record.failure)
      issue(["failure"], "successful execution cannot contain a failure");
    if (record.scope.changedFiles.length === 0)
      issue(
        ["scope", "changedFiles"],
        "successful execution requires source changes",
      );
    if (record.scope.violations.length > 0)
      issue(
        ["scope", "violations"],
        "successful execution cannot contain scope violations",
      );
    if (record.scope.deletedFiles.length > 0)
      issue(
        ["scope", "deletedFiles"],
        "successful extraction execution cannot contain deleted files",
      );
    if (
      record.validation.length === 0 ||
      record.validation.some(
        (result) =>
          result.status === "failed" ||
          result.status === "timeout" ||
          (result.required && result.status !== "passed"),
      )
    )
      issue(
        ["validation"],
        "successful execution requires passing validations without failures or timeouts",
      );
    if (record.executor.exitCode !== 0)
      issue(
        ["executor", "exitCode"],
        "successful execution requires executor exit code 0",
      );
    if (record.executor.timedOut !== false)
      issue(
        ["executor", "timedOut"],
        "successful execution requires a non-timeout executor result",
      );
    if (record.executor.sandbox !== "workspace-write")
      issue(
        ["executor", "sandbox"],
        "successful execution requires the workspace-write sandbox",
      );
    record.validation.forEach((result, index) => {
      if (result.status === "passed" && result.exitCode !== 0)
        issue(
          ["validation", index, "exitCode"],
          "passed validation requires exit code 0",
        );
      if (result.status === "warning" && result.required)
        issue(
          ["validation", index, "required"],
          "validation warnings must be optional",
        );
      if (result.status === "warning" && result.exitCode === 0)
        issue(
          ["validation", index, "exitCode"],
          "validation warnings cannot carry a successful exit code",
        );
    });
    for (const [field, value] of Object.entries({
      afterSnapshotId: record.architecture.afterSnapshotId,
      actualImpact: record.architecture.actualImpact,
      comparison: record.architecture.comparison,
    }))
      if (value === undefined)
        issue(
          ["architecture", field],
          `successful execution requires ${field}`,
        );
    for (const [field, value] of Object.entries({
      mainAfter: record.fingerprints.mainAfter,
      candidateAfter: record.fingerprints.candidateAfter,
      diffHash: record.fingerprints.diffHash,
    }))
      if (value === undefined)
        issue(
          ["fingerprints", field],
          `successful execution requires ${field}`,
        );
    for (const [field, value] of Object.entries({
      eventLog: record.artifacts.eventLog,
      patch: record.artifacts.patch,
      validationReport: record.artifacts.validationReport,
    }))
      if (value === undefined)
        issue(["artifacts", field], `successful execution requires ${field}`);
    if (record.executor.kind === "codex" && !record.artifacts.finalSummary)
      issue(
        ["artifacts", "finalSummary"],
        "successful Codex execution requires its structured final summary",
      );
    if (record.fingerprints.mainAfter !== record.fingerprints.mainBefore)
      issue(
        ["fingerprints", "mainAfter"],
        "successful execution requires an unchanged main checkout",
      );
    const actual = record.architecture.actualImpact;
    if (
      actual &&
      (!actual.selectedSymbolsMoved ||
        !actual.sourceModuleChanged ||
        !actual.destinationModuleChanged ||
        actual.newCycles !== 0 ||
        actual.publicApiChanged ||
        actual.protectedPathViolation ||
        !actual.intendedOutcomeAchieved)
    )
      issue(
        ["architecture", "actualImpact"],
        "successful execution requires passing architecture impact",
      );
    if (
      actual &&
      record.architecture.comparison &&
      JSON.stringify(record.architecture.comparison.actual) !==
        JSON.stringify(actual)
    )
      issue(
        ["architecture", "comparison", "actual"],
        "comparison actual impact must match the execution impact",
      );
    if (
      record.architecture.comparison &&
      JSON.stringify(record.architecture.comparison.predicted) !==
        JSON.stringify(record.architecture.predictedImpact)
    )
      issue(
        ["architecture", "comparison", "predicted"],
        "comparison prediction must match the execution prediction",
      );
  });

export const codexMigrationSummarySchema = z.object({
  status: z.enum(["completed", "blocked", "failed"]),
  changedFiles: z.array(projectRelativePathSchema),
  addedFiles: z.array(projectRelativePathSchema),
  testsRun: z.array(z.string()),
  summary: z.string(),
  unresolvedConcerns: z.array(z.string()),
});

export type ValidationCommand = z.infer<typeof validationCommandSchema>;
export type SourceManifestEntry = z.infer<typeof sourceManifestEntrySchema>;
export type SourceFingerprint = z.infer<typeof sourceFingerprintSchema>;
export type ScopeViolation = z.infer<typeof scopeViolationSchema>;
export type MigrationExecutionStatus = z.infer<
  typeof migrationExecutionStatusSchema
>;
export type MigrationExecutionPlan = z.infer<
  typeof migrationExecutionPlanSchema
>;
export type ValidationResult = z.infer<typeof validationResultSchema>;
export type MigrationArchitectureImpact = z.infer<
  typeof migrationArchitectureImpactSchema
>;
export type ImpactComparison = z.infer<typeof impactComparisonSchema>;
export type MigrationExecutionRecord = z.infer<
  typeof migrationExecutionRecordSchema
>;
export type CodexMigrationSummary = z.infer<typeof codexMigrationSummarySchema>;
