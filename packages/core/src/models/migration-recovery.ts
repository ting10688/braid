import { z } from "zod";

export const RECOVERY_JOURNAL_SCHEMA_VERSION = "1.0.0" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const executionIdSchema = z
  .string()
  .regex(/^E-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const proposalIdSchema = z.string().regex(/^P-(?:EM|BC)-[a-f0-9]{8}$/u);
const planIdSchema = z.string().regex(/^PL-[a-f0-9]{16}$/u);
const stableTokenSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const singleLineSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && !/[\r\n]/u.test(value), {
    message: "must not contain NUL or line breaks",
  });
const portableLocatorSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !value.startsWith("file://") &&
      !/^[A-Za-z]:/u.test(value) &&
      !value.split("/").some((segment) => ["", ".", ".."].includes(segment)),
    "must be a normalized portable relative locator",
  );
const candidateRefSchema = z
  .string()
  .regex(/^refs\/heads\/braid\/exec\/[a-f0-9]{8}$/u);
const gitModeSchema = z.enum(["100644", "100755", "120000", "160000"]);

export const migrationRecoveryCheckpointSchema = z.enum([
  "planned",
  "preflight-passed",
  "staging-created",
  "executor-started",
  "executor-finished",
  "patch-captured",
  "scope-verified",
  "validation-passed",
  "architecture-passed",
  "candidate-prepared",
  "candidate-created",
  "completed",
  "failed",
  "discarded",
]);

export const migrationRecoveryClassificationSchema = z.enum([
  "resumable",
  "cleanup-required",
  "already-complete",
  "unsafe-to-resume",
  "manual-inspection-required",
]);

export const migrationRecoveryIdentitySchema = z
  .object({
    repositoryId: sha256Schema,
    gitCommonDirectoryId: sha256Schema,
    originatingWorktreeId: sha256Schema,
    configHash: sha256Schema,
    sourceFingerprint: sha256Schema,
    approvalHash: sha256Schema,
    planHash: sha256Schema,
    proposalHash: sha256Schema,
  })
  .strict();

export const migrationResourceTypeSchema = z.enum([
  "staging-repository",
  "candidate-worktree",
  "candidate-ref",
  "patch-artifact",
  "journal",
  "candidate-index",
  "process-metadata",
]);

export const migrationResourceOwnershipSchema = z
  .object({
    resourceId: stableTokenSchema,
    resourceType: migrationResourceTypeSchema,
    executionId: executionIdSchema,
    repositoryId: sha256Schema,
    baseCommit: gitObjectSchema,
    portableLocator: portableLocatorSchema,
    creationCheckpoint: migrationRecoveryCheckpointSchema,
    integrityHash: sha256Schema,
    gitIdentity: z
      .object({
        commonDirectoryId: sha256Schema,
        worktreeId: sha256Schema.optional(),
        head: gitObjectSchema.nullable(),
        ref: candidateRefSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((resource, context) => {
    if (
      resource.resourceType === "candidate-ref" &&
      !candidateRefSchema.safeParse(resource.portableLocator).success
    )
      context.addIssue({
        code: "custom",
        path: ["portableLocator"],
        message: "candidate ref must be an owned Braid execution ref",
      });
    if (
      resource.resourceType === "candidate-ref" &&
      resource.gitIdentity?.ref !== resource.portableLocator
    )
      context.addIssue({
        code: "custom",
        path: ["gitIdentity", "ref"],
        message: "candidate ref ownership must bind the same Git ref",
      });
  });

const plannedEvidenceSchema = z
  .object({
    checkpoint: z.literal("planned"),
    executorInvocationId: stableTokenSchema,
    executorConfigHash: sha256Schema,
    createCommit: z.boolean(),
    resources: z.array(migrationResourceOwnershipSchema).min(1),
  })
  .strict();

const preflightPassedEvidenceSchema = z
  .object({
    checkpoint: z.literal("preflight-passed"),
    freshnessHash: sha256Schema,
    preflightHash: sha256Schema,
  })
  .strict();

const stagingCreatedEvidenceSchema = z
  .object({
    checkpoint: z.literal("staging-created"),
    stagingResource: migrationResourceOwnershipSchema,
    candidateWorktreeResource: migrationResourceOwnershipSchema,
    candidateRefResource: migrationResourceOwnershipSchema,
    markerHash: sha256Schema,
    initialCommit: gitObjectSchema,
    noRemotes: z.literal(true),
  })
  .strict();

const executorStartedEvidenceSchema = z
  .object({
    checkpoint: z.literal("executor-started"),
    invocationId: stableTokenSchema,
    configurationHash: sha256Schema,
    kind: z.enum(["codex", "scripted-test"]),
    timeoutMs: z.number().int().min(1_000).max(900_000),
    sandbox: z.literal("workspace-write"),
    processResource: migrationResourceOwnershipSchema,
  })
  .strict();

const executorFinishedEvidenceSchema = z
  .object({
    checkpoint: z.literal("executor-finished"),
    invocationId: stableTokenSchema,
    exitCode: z.number().int(),
    timedOut: z.boolean(),
    stdoutHash: sha256Schema,
    stderrHash: sha256Schema,
    cleanupHash: sha256Schema,
    processGroupClean: z.literal(true),
    stagingFingerprint: sha256Schema,
  })
  .strict();

const patchModeSchema = z
  .object({
    path: portableLocatorSchema,
    before: gitModeSchema.nullable(),
    after: gitModeSchema.nullable(),
  })
  .strict()
  .refine(({ before, after }) => before !== null || after !== null, {
    message: "patch mode must describe an existing side",
  });

const patchCapturedEvidenceSchema = z
  .object({
    checkpoint: z.literal("patch-captured"),
    patchHash: sha256Schema,
    stagingFingerprint: sha256Schema,
    changedFiles: z.array(portableLocatorSchema).min(1),
    modes: z.array(patchModeSchema).min(1),
    patchResource: migrationResourceOwnershipSchema,
  })
  .strict();

const scopeVerifiedEvidenceSchema = z
  .object({
    checkpoint: z.literal("scope-verified"),
    inputHash: sha256Schema,
    resultHash: sha256Schema,
    accepted: z.literal(true),
  })
  .strict();

const validationPassedEvidenceSchema = z
  .object({
    checkpoint: z.literal("validation-passed"),
    inputHash: sha256Schema,
    commandsHash: sha256Schema,
    resultHashes: z.array(sha256Schema).min(1),
  })
  .strict();

const architecturePassedEvidenceSchema = z
  .object({
    checkpoint: z.literal("architecture-passed"),
    inputHash: sha256Schema,
    resultHash: sha256Schema,
    accepted: z.literal(true),
  })
  .strict();

const gitActorSchema = z
  .object({
    name: singleLineSchema,
    email: z.string().email(),
  })
  .strict();

const candidatePreparedEvidenceSchema = z
  .object({
    checkpoint: z.literal("candidate-prepared"),
    parent: gitObjectSchema,
    tree: gitObjectSchema,
    message: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0"), {
        message: "must not contain NUL",
      }),
    author: gitActorSchema,
    committer: gitActorSchema,
    timestamp: z.number().int().nonnegative(),
    timezone: z.literal("+0000"),
    ref: candidateRefSchema,
    expectedCommit: gitObjectSchema,
    indexResource: migrationResourceOwnershipSchema,
    createCommit: z.literal(true),
  })
  .strict();

const candidateCreatedEvidenceSchema = z
  .object({
    checkpoint: z.literal("candidate-created"),
    commit: gitObjectSchema,
    tree: gitObjectSchema,
    parent: gitObjectSchema,
    ref: candidateRefSchema,
    verified: z.literal(true),
    verificationHash: sha256Schema,
  })
  .strict();

const completedEvidenceSchema = z
  .object({
    checkpoint: z.literal("completed"),
    executionRecordHash: sha256Schema,
    terminalDisposition: z.literal("succeeded"),
  })
  .strict();

const terminalEvidenceFields = {
  stage: stableTokenSchema,
  code: stableTokenSchema,
  outcomeHash: sha256Schema,
} as const;

const failedEvidenceSchema = z
  .object({ checkpoint: z.literal("failed"), ...terminalEvidenceFields })
  .strict();
const discardedEvidenceSchema = z
  .object({ checkpoint: z.literal("discarded"), ...terminalEvidenceFields })
  .strict();

export const migrationRecoveryEvidenceSchema = z
  .discriminatedUnion("checkpoint", [
    plannedEvidenceSchema,
    preflightPassedEvidenceSchema,
    stagingCreatedEvidenceSchema,
    executorStartedEvidenceSchema,
    executorFinishedEvidenceSchema,
    patchCapturedEvidenceSchema,
    scopeVerifiedEvidenceSchema,
    validationPassedEvidenceSchema,
    architecturePassedEvidenceSchema,
    candidatePreparedEvidenceSchema,
    candidateCreatedEvidenceSchema,
    completedEvidenceSchema,
    failedEvidenceSchema,
    discardedEvidenceSchema,
  ])
  .superRefine((evidence, context) => {
    if (
      evidence.checkpoint === "planned" &&
      !evidence.resources.some(
        ({ resourceType, creationCheckpoint }) =>
          resourceType === "journal" && creationCheckpoint === "planned",
      )
    )
      context.addIssue({
        code: "custom",
        path: ["resources"],
        message: "planned evidence must bind journal ownership",
      });
    if (
      evidence.checkpoint === "staging-created" &&
      (evidence.stagingResource.resourceType !== "staging-repository" ||
        evidence.stagingResource.creationCheckpoint !== "staging-created")
    )
      context.addIssue({
        code: "custom",
        path: ["stagingResource", "resourceType"],
        message: "staging evidence requires staging-repository ownership",
      });
    if (
      evidence.checkpoint === "staging-created" &&
      (evidence.candidateWorktreeResource.resourceType !==
        "candidate-worktree" ||
        evidence.candidateWorktreeResource.creationCheckpoint !==
          "staging-created")
    )
      context.addIssue({
        code: "custom",
        path: ["candidateWorktreeResource"],
        message: "staging evidence requires candidate-worktree ownership",
      });
    if (
      evidence.checkpoint === "staging-created" &&
      (evidence.candidateRefResource.resourceType !== "candidate-ref" ||
        evidence.candidateRefResource.creationCheckpoint !== "staging-created")
    )
      context.addIssue({
        code: "custom",
        path: ["candidateRefResource"],
        message: "staging evidence requires candidate-ref ownership",
      });
    if (
      evidence.checkpoint === "executor-started" &&
      (evidence.processResource.resourceType !== "process-metadata" ||
        evidence.processResource.creationCheckpoint !== "executor-started")
    )
      context.addIssue({
        code: "custom",
        path: ["processResource"],
        message: "executor evidence requires process-metadata ownership",
      });
    if (
      evidence.checkpoint === "patch-captured" &&
      evidence.patchResource.resourceType !== "patch-artifact"
    )
      context.addIssue({
        code: "custom",
        path: ["patchResource", "resourceType"],
        message: "patch evidence requires patch-artifact ownership",
      });
    if (
      evidence.checkpoint === "patch-captured" &&
      evidence.patchResource.creationCheckpoint !== "patch-captured"
    )
      context.addIssue({
        code: "custom",
        path: ["patchResource", "creationCheckpoint"],
        message: "patch ownership must bind patch-captured creation",
      });
    if (evidence.checkpoint === "patch-captured") {
      const changed = new Set(evidence.changedFiles);
      const modePaths = new Set(evidence.modes.map(({ path }) => path));
      if (
        changed.size !== evidence.changedFiles.length ||
        modePaths.size !== evidence.modes.length ||
        changed.size !== modePaths.size ||
        [...changed].some((path) => !modePaths.has(path))
      )
        context.addIssue({
          code: "custom",
          path: ["modes"],
          message: "patch modes must bind each changed file exactly once",
        });
    }
    if (
      evidence.checkpoint === "candidate-prepared" &&
      evidence.indexResource.resourceType !== "candidate-index"
    )
      context.addIssue({
        code: "custom",
        path: ["indexResource", "resourceType"],
        message: "candidate preparation requires candidate-index ownership",
      });
    if (
      evidence.checkpoint === "candidate-prepared" &&
      evidence.indexResource.creationCheckpoint !== "candidate-prepared"
    )
      context.addIssue({
        code: "custom",
        path: ["indexResource", "creationCheckpoint"],
        message: "candidate index must bind candidate-prepared creation",
      });
  });

export const migrationRecoveryJournalEntrySchema = z
  .object({
    schemaVersion: z.literal(RECOVERY_JOURNAL_SCHEMA_VERSION),
    journalId: z.string().regex(/^RJ-[a-f0-9]{16}$/u),
    executionId: executionIdSchema,
    proposalId: proposalIdSchema,
    planId: planIdSchema,
    baseCommit: gitObjectSchema,
    sequence: z.number().int().nonnegative(),
    previousEntryHash: sha256Schema.nullable(),
    semanticHash: sha256Schema,
    entryHash: sha256Schema,
    checkpoint: migrationRecoveryCheckpointSchema,
    identity: migrationRecoveryIdentitySchema,
    evidence: migrationRecoveryEvidenceSchema,
    recordedAt: z.string().datetime(),
    diagnostics: z.array(z.string()),
  })
  .strict()
  .superRefine((entry, context) => {
    const resources: MigrationResourceOwnership[] =
      entry.evidence.checkpoint === "planned"
        ? entry.evidence.resources
        : entry.evidence.checkpoint === "staging-created"
          ? [
              entry.evidence.stagingResource,
              entry.evidence.candidateWorktreeResource,
              entry.evidence.candidateRefResource,
            ]
          : entry.evidence.checkpoint === "executor-started"
            ? [entry.evidence.processResource]
            : entry.evidence.checkpoint === "patch-captured"
              ? [entry.evidence.patchResource]
              : entry.evidence.checkpoint === "candidate-prepared"
                ? [entry.evidence.indexResource]
                : [];
    if (entry.checkpoint !== entry.evidence.checkpoint)
      context.addIssue({
        code: "custom",
        path: ["evidence", "checkpoint"],
        message: "must match the journal entry checkpoint",
      });
    if ((entry.sequence === 0) !== (entry.previousEntryHash === null))
      context.addIssue({
        code: "custom",
        path: ["previousEntryHash"],
        message: "only the first sequence may omit its previous entry hash",
      });
    if (entry.sequence === 0 && entry.checkpoint !== "planned")
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "the first journal entry must be planned",
      });
    if (entry.checkpoint === "planned" && entry.sequence !== 0)
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "planned may only be the first journal entry",
      });
    resources.forEach((resource, index) => {
      if (
        resource.executionId !== entry.executionId ||
        resource.repositoryId !== entry.identity.repositoryId ||
        resource.baseCommit !== entry.baseCommit
      )
        context.addIssue({
          code: "custom",
          path: ["evidence", "resources", index],
          message: "resource ownership must match the journal identity",
        });
      if (
        entry.checkpoint !== "planned" &&
        resource.creationCheckpoint !== entry.checkpoint
      )
        context.addIssue({
          code: "custom",
          path: ["evidence", "resources", index, "creationCheckpoint"],
          message: "resource ownership must bind its creation checkpoint",
        });
    });
  });

export const migrationRecoveryLockStatusSchema = z.enum([
  "unlocked",
  "live",
  "stale",
  "ambiguous",
]);

const recoveryIntegritySchema = z
  .object({
    valid: z.boolean(),
    code: stableTokenSchema.optional(),
    message: singleLineSchema.optional(),
    temporaryFiles: z.array(portableLocatorSchema),
  })
  .strict()
  .superRefine((integrity, context) => {
    if (integrity.valid && (integrity.code || integrity.message))
      context.addIssue({
        code: "custom",
        message: "valid integrity cannot contain an error code or message",
      });
    if (!integrity.valid && (!integrity.code || !integrity.message))
      context.addIssue({
        code: "custom",
        message: "invalid integrity requires an error code and message",
      });
  });

export const migrationRecoveryReportSchema = z
  .object({
    schemaVersion: z.literal(RECOVERY_JOURNAL_SCHEMA_VERSION),
    reportId: z.string().regex(/^RR-[a-f0-9]{16}$/u),
    executionId: executionIdSchema,
    classification: migrationRecoveryClassificationSchema,
    latestCheckpoint: migrationRecoveryCheckpointSchema.nullable(),
    integrity: recoveryIntegritySchema,
    nextSafeAction: singleLineSchema,
    executorLaunchPermitted: z.boolean(),
    candidateCreationPermitted: z.boolean(),
    cleanupEligible: z.boolean(),
    lock: z.object({ status: migrationRecoveryLockStatusSchema }).strict(),
    resources: z.array(migrationResourceOwnershipSchema),
  })
  .strict()
  .superRefine((report, context) => {
    const issue = (path: string[], message: string): void =>
      context.addIssue({ code: "custom", path, message });
    if (
      ["resumable", "already-complete"].includes(report.classification) &&
      !report.integrity.valid
    )
      issue(
        ["classification"],
        "resumable and complete reports require valid journal integrity",
      );
    if (
      report.classification === "resumable" &&
      (report.latestCheckpoint === null ||
        ["executor-started", "completed", "failed", "discarded"].includes(
          report.latestCheckpoint,
        ))
    )
      issue(
        ["latestCheckpoint"],
        "checkpoint cannot be resumed without repeating or bypassing work",
      );
    if (
      report.classification === "resumable" &&
      ["live", "ambiguous"].includes(report.lock.status)
    )
      issue(["lock", "status"], "resumable report requires an available lock");
    if (
      report.classification === "already-complete" &&
      report.latestCheckpoint !== "completed"
    )
      issue(
        ["latestCheckpoint"],
        "already-complete report requires the completed checkpoint",
      );
    if (
      report.classification !== "resumable" &&
      (report.executorLaunchPermitted || report.candidateCreationPermitted)
    )
      issue(
        ["classification"],
        "only resumable reports may permit execution mutations",
      );
    if (report.classification === "cleanup-required" && !report.cleanupEligible)
      issue(
        ["cleanupEligible"],
        "cleanup-required report must prove cleanup eligibility",
      );
    if (
      report.classification === "manual-inspection-required" &&
      report.cleanupEligible
    )
      issue(
        ["cleanupEligible"],
        "ambiguous evidence cannot authorize automatic cleanup",
      );
    if (
      report.executorLaunchPermitted &&
      !["planned", "preflight-passed", "staging-created"].includes(
        report.latestCheckpoint ?? "",
      )
    )
      issue(
        ["executorLaunchPermitted"],
        "executor launch is only possible before executor-started",
      );
    if (
      report.candidateCreationPermitted &&
      report.latestCheckpoint !== "candidate-prepared"
    )
      issue(
        ["candidateCreationPermitted"],
        "candidate creation requires durable prepared inputs",
      );
  });

export type MigrationRecoveryCheckpoint = z.infer<
  typeof migrationRecoveryCheckpointSchema
>;
export type MigrationRecoveryClassification = z.infer<
  typeof migrationRecoveryClassificationSchema
>;
export type MigrationRecoveryIdentity = z.infer<
  typeof migrationRecoveryIdentitySchema
>;
export type MigrationResourceType = z.infer<typeof migrationResourceTypeSchema>;
export type MigrationResourceOwnership = z.infer<
  typeof migrationResourceOwnershipSchema
>;
export type MigrationRecoveryEvidence = z.infer<
  typeof migrationRecoveryEvidenceSchema
>;
export type MigrationRecoveryJournalEntry = z.infer<
  typeof migrationRecoveryJournalEntrySchema
>;
export type MigrationRecoveryLockStatus = z.infer<
  typeof migrationRecoveryLockStatusSchema
>;
export type MigrationRecoveryReport = z.infer<
  typeof migrationRecoveryReportSchema
>;
