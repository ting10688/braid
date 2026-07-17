import { describe, expect, it } from "vitest";
import {
  RECOVERY_JOURNAL_SCHEMA_VERSION,
  migrationRecoveryCheckpointSchema,
  migrationRecoveryClassificationSchema,
  migrationRecoveryEvidenceSchema,
  migrationRecoveryJournalEntrySchema,
  migrationRecoveryReportSchema,
  migrationResourceOwnershipSchema,
  type MigrationRecoveryCheckpoint,
  type MigrationResourceType,
} from "../src/index.js";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const commit = "c".repeat(40);
const tree = "d".repeat(40);
const expectedCommit = "e".repeat(40);
const executionId = "E-12345678-1234-1234-1234-123456789abc";
const repositoryId = "f".repeat(64);

const ownership = (
  resourceType: MigrationResourceType,
  portableLocator: string,
  creationCheckpoint: MigrationRecoveryCheckpoint,
) => ({
  resourceId: `resource.${resourceType}`,
  resourceType,
  executionId,
  repositoryId,
  baseCommit: commit,
  portableLocator,
  creationCheckpoint,
  integrityHash: hash,
  ...(resourceType === "candidate-ref"
    ? {
        gitIdentity: {
          commonDirectoryId: hash,
          head: commit,
          ref: portableLocator,
        },
      }
    : {}),
});

const identity = {
  repositoryId,
  gitCommonDirectoryId: hash,
  originatingWorktreeId: otherHash,
  configHash: hash,
  sourceFingerprint: hash,
  approvalHash: hash,
  planHash: hash,
  proposalHash: hash,
};

const evidence = {
  planned: {
    checkpoint: "planned",
    executorInvocationId: "invocation:12345678",
    executorConfigHash: hash,
    createCommit: true,
    resources: [ownership("journal", ".braid/executions/journal", "planned")],
  },
  "preflight-passed": {
    checkpoint: "preflight-passed",
    freshnessHash: hash,
    preflightHash: otherHash,
  },
  "staging-created": {
    checkpoint: "staging-created",
    stagingResource: ownership(
      "staging-repository",
      ".braid/executions/staging",
      "staging-created",
    ),
    candidateWorktreeResource: ownership(
      "candidate-worktree",
      ".braid/executions/candidate-worktree",
      "staging-created",
    ),
    candidateRefResource: ownership(
      "candidate-ref",
      "refs/heads/braid/exec/12345678",
      "staging-created",
    ),
    markerHash: hash,
    initialCommit: commit,
    noRemotes: true,
  },
  "executor-started": {
    checkpoint: "executor-started",
    invocationId: "invocation:12345678",
    configurationHash: hash,
    kind: "scripted-test",
    timeoutMs: 120_000,
    sandbox: "workspace-write",
    processResource: ownership(
      "process-metadata",
      ".braid/executions/process.json",
      "executor-started",
    ),
  },
  "executor-finished": {
    checkpoint: "executor-finished",
    invocationId: "invocation:12345678",
    exitCode: 0,
    timedOut: false,
    stdoutHash: hash,
    stderrHash: hash,
    cleanupHash: hash,
    processGroupClean: true,
    stagingFingerprint: otherHash,
  },
  "patch-captured": {
    checkpoint: "patch-captured",
    patchHash: hash,
    stagingFingerprint: otherHash,
    changedFiles: ["src/orders.ts", "src/notifications.ts"],
    modes: [
      { path: "src/orders.ts", before: "100644", after: "100644" },
      { path: "src/notifications.ts", before: null, after: "100644" },
    ],
    patchResource: ownership(
      "patch-artifact",
      ".braid/executions/candidate.patch",
      "patch-captured",
    ),
  },
  "scope-verified": {
    checkpoint: "scope-verified",
    inputHash: hash,
    resultHash: otherHash,
    accepted: true,
  },
  "validation-passed": {
    checkpoint: "validation-passed",
    inputHash: hash,
    commandsHash: otherHash,
    resultHashes: [hash, otherHash],
  },
  "architecture-passed": {
    checkpoint: "architecture-passed",
    inputHash: hash,
    resultHash: otherHash,
    accepted: true,
  },
  "candidate-prepared": {
    checkpoint: "candidate-prepared",
    parent: commit,
    tree,
    message: "braid: execute P-EM-a18d42f3",
    author: { name: "Braid Migrator", email: "braid@example.invalid" },
    committer: { name: "Braid Migrator", email: "braid@example.invalid" },
    timestamp: 1_784_160_000,
    timezone: "+0000",
    ref: "refs/heads/braid/exec/12345678",
    expectedCommit,
    indexResource: ownership(
      "candidate-index",
      ".braid/executions/candidate.index",
      "candidate-prepared",
    ),
    createCommit: true,
  },
  "candidate-created": {
    checkpoint: "candidate-created",
    commit: expectedCommit,
    tree,
    parent: commit,
    ref: "refs/heads/braid/exec/12345678",
    verified: true,
    verificationHash: hash,
  },
  completed: {
    checkpoint: "completed",
    executionRecordHash: hash,
    terminalDisposition: "succeeded",
  },
  failed: {
    checkpoint: "failed",
    stage: "validation",
    code: "validation-failed",
    outcomeHash: hash,
  },
  discarded: {
    checkpoint: "discarded",
    stage: "cleanup",
    code: "user-discarded",
    outcomeHash: hash,
  },
} as const;

describe("migration recovery public models", () => {
  it("exposes the fixed schema, checkpoint, and classification vocabularies", () => {
    expect(RECOVERY_JOURNAL_SCHEMA_VERSION).toBe("1.0.0");
    expect(migrationRecoveryCheckpointSchema.options).toEqual([
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
    expect(migrationRecoveryClassificationSchema.options).toEqual([
      "resumable",
      "cleanup-required",
      "already-complete",
      "unsafe-to-resume",
      "manual-inspection-required",
    ]);
    expect(
      migrationRecoveryClassificationSchema.safeParse("recoverable").success,
    ).toBe(false);
  });

  it("accepts evidence for every durable checkpoint", () => {
    for (const checkpoint of migrationRecoveryCheckpointSchema.options)
      expect(
        migrationRecoveryEvidenceSchema.parse(evidence[checkpoint]),
      ).toEqual(evidence[checkpoint]);
  });

  it("rejects mismatched ownership, patch modes, and private locators", () => {
    expect(
      migrationRecoveryEvidenceSchema.safeParse({
        ...evidence.planned,
        resources: [
          ownership(
            "process-metadata",
            ".braid/executions/process.json",
            "planned",
          ),
        ],
      }).success,
    ).toBe(false);
    expect(
      migrationRecoveryEvidenceSchema.safeParse({
        ...evidence["staging-created"],
        stagingResource: ownership(
          "candidate-worktree",
          ".braid/executions/staging",
          "staging-created",
        ),
      }).success,
    ).toBe(false);
    expect(
      migrationRecoveryEvidenceSchema.safeParse({
        ...evidence["patch-captured"],
        modes: [evidence["patch-captured"].modes[0]],
      }).success,
    ).toBe(false);
    expect(
      migrationResourceOwnershipSchema.safeParse({
        ...ownership("journal", ".braid/executions/journal", "planned"),
        portableLocator: "/Users/example/private/journal",
      }).success,
    ).toBe(false);
  });

  it("binds deterministic candidate inputs to an owned Braid ref and index", () => {
    expect(
      migrationRecoveryEvidenceSchema.parse(evidence["candidate-prepared"]),
    ).toEqual(evidence["candidate-prepared"]);
    expect(
      migrationRecoveryEvidenceSchema.safeParse({
        ...evidence["candidate-prepared"],
        ref: "refs/heads/user/candidate",
      }).success,
    ).toBe(false);
    expect(
      migrationRecoveryEvidenceSchema.safeParse({
        ...evidence["candidate-prepared"],
        indexResource: ownership(
          "patch-artifact",
          ".braid/executions/candidate.index",
          "candidate-prepared",
        ),
      }).success,
    ).toBe(false);
    expect(
      migrationResourceOwnershipSchema.safeParse(
        ownership(
          "candidate-ref",
          "refs/heads/braid/exec/12345678",
          "candidate-created",
        ),
      ).success,
    ).toBe(true);
  });

  it("requires entry sequence linkage and matching evidence", () => {
    const entry = {
      schemaVersion: RECOVERY_JOURNAL_SCHEMA_VERSION,
      journalId: "RJ-1234567890abcdef",
      executionId,
      proposalId: "P-EM-a18d42f3",
      planId: "PL-1234567890abcdef",
      baseCommit: commit,
      sequence: 0,
      previousEntryHash: null,
      semanticHash: hash,
      entryHash: otherHash,
      checkpoint: "planned",
      identity,
      evidence: evidence.planned,
      recordedAt: "2026-07-16T00:00:00.000Z",
      diagnostics: [],
    } as const;
    expect(migrationRecoveryJournalEntrySchema.parse(entry)).toEqual(entry);
    expect(
      migrationRecoveryJournalEntrySchema.safeParse({
        ...entry,
        previousEntryHash: hash,
      }).success,
    ).toBe(false);
    expect(
      migrationRecoveryJournalEntrySchema.safeParse({
        ...entry,
        checkpoint: "preflight-passed",
      }).success,
    ).toBe(false);
    expect(
      migrationRecoveryJournalEntrySchema.safeParse({
        ...entry,
        evidence: {
          ...entry.evidence,
          resources: [
            ...entry.evidence.resources,
            ownership(
              "staging-repository",
              ".braid/executions/future-staging",
              "staging-created",
            ),
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects recovery reports that authorize unsafe mutations", () => {
    const report = {
      schemaVersion: RECOVERY_JOURNAL_SCHEMA_VERSION,
      reportId: "RR-1234567890abcdef",
      executionId,
      classification: "resumable",
      latestCheckpoint: "patch-captured",
      integrity: { valid: true, temporaryFiles: [] },
      nextSafeAction: "Continue from scope verification",
      executorLaunchPermitted: false,
      candidateCreationPermitted: false,
      cleanupEligible: false,
      lock: { status: "unlocked" },
      resources: [ownership("journal", ".braid/executions/journal", "planned")],
    } as const;
    expect(migrationRecoveryReportSchema.parse(report)).toEqual(report);
    expect(
      migrationRecoveryReportSchema.safeParse({
        ...report,
        latestCheckpoint: "executor-started",
        executorLaunchPermitted: true,
      }).success,
    ).toBe(false);
    expect(
      migrationRecoveryReportSchema.safeParse({
        ...report,
        classification: "manual-inspection-required",
        cleanupEligible: true,
      }).success,
    ).toBe(false);
    expect(
      migrationRecoveryReportSchema.safeParse({
        ...report,
        latestCheckpoint: "architecture-passed",
        candidateCreationPermitted: true,
      }).success,
    ).toBe(false);
  });
});
