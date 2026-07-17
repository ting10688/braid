import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  codexMigrationSummarySchema,
  architectureSnapshotSchema,
  configHash,
  createArchitectureSnapshot,
  executionConfigHash,
  migrationExecutionRecordSchema,
  migrationConfigHash,
  validationResultSchema,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type MigrationExecutionRecord,
  type MigrationProposal,
  type MigrationRecoveryJournalEntry,
  type MigrationRecoveryReport,
  type MigrationResourceOwnership,
  type ScopeViolation,
  type ValidationResult,
  type ImpactComparison,
  type MigrationArchitectureImpact,
} from "@braid/core";
import {
  JsonExecutionStore,
  JsonRecoveryJournalStore,
  type ExecutionStore,
  type RecoveryJournalStore,
} from "@braid/store";
import { EXECUTIONS_DIRECTORY, MigrationSafetyError } from "@braid/shared";
import { analyzeRepository } from "@braid/analyzer";
import {
  createPreparedCandidateCommit,
  prepareCandidateCommit,
  type CandidateCommitPreparation,
} from "./candidate-commit.js";
import {
  durableExecutorStagingPath,
  createExecutorStagingRepository,
  loadExecutorStagingRepository,
  type ExecutorStagingRepository,
} from "./executor-staging.js";
import { acquireExecutionLock } from "./execution-lock.js";
import type {
  ExecutorEvent,
  ExecutorResult,
  MigrationExecutor,
} from "./executors/executor.js";
import { compareMigrationImpact } from "./impact-comparison.js";
import {
  assertMainCheckoutIntegrity,
  captureMainCheckoutState,
} from "./main-integrity.js";
import type { MigrationRunResult } from "./migration-orchestrator.js";
import { runPreflight } from "./preflight.js";
import { buildMigrationPrompt } from "./prompt-builder.js";
import {
  appendRecoveryCheckpoint,
  checkpointEntry,
  createRecoveryJournalContext,
  recoveryArtifactLocator,
  recoveryDirectory,
  recoveryResources,
} from "./recovery-journal.js";
import {
  assertResumable,
  inspectMigrationRecovery,
} from "./recovery-inspector.js";
import {
  assertExecutorResultMatchesFinishedEvidence,
  createRecoveryProcessMetadata,
  createResourceOwnership,
  executorFinishedEvidenceFor,
  parseRecoveryProcessMetadata,
  recoveryHash,
  type DurableRecoveryExecutorResult,
  type RecoveryProcessMetadataState,
} from "./recovery-support.js";
import {
  capturePatchFileModes,
  hashNormalizedPatch,
  inspectMigrationScope,
  type ScopeInspection,
} from "./scope-policy.js";
import { createSourceFingerprint } from "./source-fingerprint.js";
import {
  captureSafetySurface,
  compareSafetySurfaces,
} from "./safety-surface.js";
import { runValidationCommands } from "./validation-runner.js";
import { redactSensitiveText } from "./safety.js";
import {
  candidateBranchForExecution,
  defaultExecutionRoot,
  WorktreeManager,
} from "./worktree-manager.js";

const execFileAsync = promisify(execFile);

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const executionDirectory = (root: string, executionId: string): string =>
  path.join(root, EXECUTIONS_DIRECTORY, executionId);

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

const git = async (root: string, arguments_: string[]): Promise<string> =>
  (
    await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout.trim();

const journalContextFrom = (entry: MigrationRecoveryJournalEntry) =>
  createRecoveryJournalContext({
    executionId: entry.executionId,
    proposalId: entry.proposalId,
    planId: entry.planId,
    baseCommit: entry.baseCommit,
    identity: entry.identity,
  });

const ownershipMarkerMatches = async (
  filePath: string,
  expected: unknown,
): Promise<boolean> => {
  try {
    return recoveryHash(await readJson(filePath)) === recoveryHash(expected);
  } catch {
    return false;
  }
};

const processMetadataState = async (
  filePath: string,
  ownership: MigrationResourceOwnership,
): Promise<RecoveryProcessMetadataState> =>
  parseRecoveryProcessMetadata(await readJson<unknown>(filePath), ownership)
    .state;

const removeOwnedProcessMetadata = async (
  filePath: string,
  ownership: MigrationResourceOwnership,
  expectedState: RecoveryProcessMetadataState,
): Promise<void> => {
  if ((await processMetadataState(filePath, ownership)) !== expectedState)
    throw new MigrationSafetyError(
      "Executor process ownership marker changed",
      12,
      "recovery-process-ownership-invalid",
    );
  await rm(filePath);
};

const transitionProcessMetadata = async (
  filePath: string,
  ownership: MigrationResourceOwnership,
  from: RecoveryProcessMetadataState,
  to: RecoveryProcessMetadataState,
): Promise<void> => {
  if ((await processMetadataState(filePath, ownership)) !== from)
    throw new MigrationSafetyError(
      "Executor process ownership marker changed",
      12,
      "recovery-process-ownership-invalid",
    );
  const temporary = `${filePath}.${process.pid}.${to}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(createRecoveryProcessMetadata(ownership, to), null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
};

export interface CleanupMigrationRecoveryInput {
  repositoryRoot: string;
  executionId: string;
  executionRoot?: string;
  journalStore?: RecoveryJournalStore;
  executionStore?: ExecutionStore;
  worktreeManager?: WorktreeManager;
  now?: () => Date;
}

export const cleanupMigrationRecovery = async (
  input: CleanupMigrationRecoveryInput,
): Promise<MigrationRecoveryReport> => {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const executionRoot =
    input.executionRoot ?? defaultExecutionRoot(repositoryRoot);
  const journalStore =
    input.journalStore ?? new JsonRecoveryJournalStore(repositoryRoot);
  const executionStore =
    input.executionStore ?? new JsonExecutionStore(repositoryRoot);
  const manager =
    input.worktreeManager ??
    new WorktreeManager({ repositoryRoot, executionRoot });
  const before = await inspectMigrationRecovery({
    repositoryRoot,
    executionRoot,
    executionId: input.executionId,
    journalStore,
    executionStore,
    worktreeManager: manager,
  });
  if (!before.cleanupEligible)
    throw new MigrationSafetyError(
      `Execution ${input.executionId} has no conclusively owned cleanup`,
      12,
      !before.integrity.valid &&
        ![
          "repository-identity-mismatch",
          "resource-ownership-ambiguous",
          "resource-integrity-mismatch",
        ].includes(before.integrity.code ?? "")
        ? "recovery-journal-integrity-failed"
        : "recovery-cleanup-not-eligible",
    );
  const journal = await journalStore.loadJournal(input.executionId);
  const first = journal.entries[0];
  if (!first || !journal.integrity.valid)
    throw new MigrationSafetyError(
      "Recovery journal integrity is invalid",
      12,
      "recovery-journal-integrity-failed",
    );
  const lock = await acquireExecutionLock({
    projectRoot: repositoryRoot,
    executionId: input.executionId,
    repositoryId: first.identity.repositoryId,
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    const locked = await inspectMigrationRecovery({
      repositoryRoot,
      executionRoot,
      executionId: input.executionId,
      journalStore,
      executionStore,
      worktreeManager: manager,
      ownedLockToken: lock.owner.token,
    });
    if (!locked.cleanupEligible)
      throw new MigrationSafetyError(
        "Recovery state changed before cleanup",
        12,
        "recovery-cleanup-not-eligible",
      );
    const mainOptions = {
      ownedCandidateRef: `refs/heads/${candidateBranchForExecution(input.executionId)}`,
      ...(await manager
        .gitDirectory(input.executionId)
        .then((ownedWorktreeGitDirectory) => ({ ownedWorktreeGitDirectory }))
        .catch(() => ({}))),
    };
    const mainBefore = await captureMainCheckoutState(
      repositoryRoot,
      mainOptions,
    );
    const stagingEntry = checkpointEntry(journal.entries, "staging-created");
    if (stagingEntry?.evidence.checkpoint === "staging-created") {
      const container = durableExecutorStagingPath(
        executionRoot,
        input.executionId,
      );
      if (await exists(container)) {
        const staging = await loadExecutorStagingRepository({
          containerPath: container,
          executionId: input.executionId,
          repositoryId: first.identity.repositoryId,
          baseCommit: first.baseCommit,
          expectedMarkerHash: stagingEntry.evidence.markerHash,
        });
        await staging.dispose();
      }
    }
    for (const resource of recoveryResources(journal.entries).filter(
      ({ resourceType }) => resourceType === "candidate-index",
    )) {
      const target = path.resolve(repositoryRoot, resource.portableLocator);
      if (!(await exists(target))) continue;
      const marker = (await lstat(target)).isDirectory()
        ? path.join(target, "ownership.json")
        : target;
      if (!(await ownershipMarkerMatches(marker, resource)))
        throw new MigrationSafetyError(
          `${resource.resourceType} ownership became ambiguous`,
          12,
          "recovery-cleanup-ownership-invalid",
        );
      await rm(target, { recursive: true });
    }
    for (const resource of recoveryResources(journal.entries).filter(
      ({ resourceType }) => resourceType === "process-metadata",
    )) {
      const target = path.resolve(repositoryRoot, resource.portableLocator);
      if (!(await exists(target))) continue;
      await removeOwnedProcessMetadata(target, resource, "prepared");
    }
    if (stagingEntry) await manager.discard(input.executionId);
    const mainAfter = await captureMainCheckoutState(
      repositoryRoot,
      mainOptions,
    );
    assertMainCheckoutIntegrity(mainBefore, mainAfter);

    const latest = journal.entries.at(-1)!.checkpoint;
    const cleanupOutcome = {
      executionId: input.executionId,
      latestCheckpoint: latest,
      cleanedAt: (input.now?.() ?? new Date()).toISOString(),
      resources: recoveryResources(journal.entries).map(
        ({ resourceId }) => resourceId,
      ),
      mainFingerprint: mainAfter.fingerprint,
    };
    await executionStore.writeJsonArtifact(
      input.executionId,
      "recovery/cleanup.json",
      cleanupOutcome,
    );
    if (!["failed", "discarded", "completed"].includes(latest))
      await appendRecoveryCheckpoint({
        context: journalContextFrom(first),
        store: journalStore,
        ...(input.now ? { now: input.now } : {}),
        evidence: {
          checkpoint: "discarded",
          stage: "cleanup",
          code: "owned-resources-cleaned",
          outcomeHash: recoveryHash(cleanupOutcome),
        },
      });

    const record = await executionStore
      .loadRecord(input.executionId)
      .catch(() => undefined);
    if (
      record &&
      [
        "worktree-created",
        "running",
        "executor-failed",
        "no-changes",
        "scope-violation",
        "validation-failed",
        "needs-review",
        "succeeded",
      ].includes(record.status)
    )
      await executionStore.saveRecord(
        migrationExecutionRecordSchema.parse({
          ...record,
          status: "discarded",
          completedAt: (input.now?.() ?? new Date()).toISOString(),
          fingerprints: {
            ...record.fingerprints,
            mainAfter: mainAfter.fingerprint,
          },
          failure: undefined,
        }),
      );
  } finally {
    await lock.release();
  }
  return inspectMigrationRecovery({
    repositoryRoot,
    executionRoot,
    executionId: input.executionId,
    journalStore,
    executionStore,
    worktreeManager: manager,
  });
};

const sanitizePortable = (
  value: string,
  privatePaths: readonly string[],
): string =>
  redactSensitiveText(
    [...privatePaths]
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .reduce(
        (sanitized, privatePath) =>
          sanitized.replaceAll(privatePath, "<private-path>"),
        value,
      )
      .replace(/file:\/\/\S+/gu, "<private-path>")
      .replace(
        /(^|[\s('"=])(?:[A-Za-z]:[\\/]|\/)[^\s'"<>]*/gmu,
        "$1<private-path>",
      ),
  );

const sanitizeExecutorResult = (
  result: ExecutorResult,
  invocationId: string,
  stagingFingerprint: string,
  privatePaths: readonly string[],
): DurableRecoveryExecutorResult => ({
  invocationId,
  exitCode: result.exitCode,
  timedOut: result.timedOut,
  events: result.events.map((event) => ({
    ...event,
    ...(event.message
      ? { message: sanitizePortable(event.message, privatePaths) }
      : {}),
    ...(event.command
      ? {
          command: event.command.map((part) =>
            sanitizePortable(part, privatePaths),
          ),
        }
      : {}),
  })),
  stderr: sanitizePortable(result.stderr, privatePaths),
  ...(result.summary
    ? {
        summary: codexMigrationSummarySchema.parse({
          ...result.summary,
          testsRun: result.summary.testsRun.map((item) =>
            sanitizePortable(item, privatePaths),
          ),
          summary: sanitizePortable(result.summary.summary, privatePaths),
          unresolvedConcerns: result.summary.unresolvedConcerns.map((item) =>
            sanitizePortable(item, privatePaths),
          ),
        }),
      }
    : {}),
  stagingFingerprint,
});

const usageFromEvents = (
  events: readonly ExecutorEvent[],
): MigrationExecutionRecord["executor"]["usage"] => {
  const usage = events.reduce(
    (total, event) => ({
      inputTokens: total.inputTokens + (event.usage?.inputTokens ?? 0),
      cachedInputTokens:
        total.cachedInputTokens + (event.usage?.cachedInputTokens ?? 0),
      outputTokens: total.outputTokens + (event.usage?.outputTokens ?? 0),
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
  return Object.values(usage).some((value) => value > 0) ? usage : undefined;
};

const withoutPatch = (
  inspection: ScopeInspection,
): Omit<ScopeInspection, "patch"> => {
  const { patch, ...result } = inspection;
  void patch;
  return result;
};

const mergeScopeViolations = (
  scope: ScopeInspection,
  additions: readonly ScopeViolation[],
): ScopeInspection => {
  const violations = [...scope.violations, ...additions]
    .filter(
      (item, index, values) =>
        values.findIndex(
          (candidate) =>
            candidate.code === item.code && candidate.path === item.path,
        ) === index,
    )
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        (left.path ?? "").localeCompare(right.path ?? ""),
    );
  return {
    ...scope,
    compliant: violations.length === 0,
    patch: violations.length === 0 ? scope.patch : "",
    violations,
  };
};

const portableSnapshot = (snapshot: ArchitectureSnapshot): unknown => ({
  ...snapshot,
  projectRoot: ".",
  repository: { ...snapshot.repository, projectRoot: "." },
});

const candidateFingerprint = async (
  worktreePath: string,
  patchHash: string,
): Promise<string> => {
  const source = await createSourceFingerprint(worktreePath);
  return createHash("sha256")
    .update(JSON.stringify([source.hash, patchHash]))
    .digest("hex");
};

const artifactPath = (
  root: string,
  executionId: string,
  relativePath: string,
): string => path.join(executionDirectory(root, executionId), relativePath);

const loadVerifiedExecutorResult = async (
  root: string,
  executionId: string,
  entry: MigrationRecoveryJournalEntry,
): Promise<DurableRecoveryExecutorResult> => {
  if (entry.evidence.checkpoint !== "executor-finished")
    throw new MigrationSafetyError(
      "Executor recovery evidence is invalid",
      12,
      "recovery-executor-evidence-invalid",
    );
  try {
    return assertExecutorResultMatchesFinishedEvidence(
      await readJson<unknown>(
        artifactPath(root, executionId, "recovery/executor-result.json"),
      ),
      entry.evidence,
    );
  } catch (error) {
    throw new MigrationSafetyError(
      "Executor result artifact does not match the journal",
      12,
      "recovery-executor-result-mismatch",
      { cause: error },
    );
  }
};

const portableExecutionArtifact = (
  executionId: string,
  relativePath: string,
): string =>
  path.posix.join(
    EXECUTIONS_DIRECTORY.split(path.sep).join("/"),
    executionId,
    relativePath,
  );

const applyPatchArtifact = async (
  worktreePath: string,
  patchPath: string,
): Promise<void> => {
  const disabledHooks = path.join(path.dirname(patchPath), "disabled-hooks");
  await execFileAsync(
    "git",
    [
      "-C",
      worktreePath,
      "-c",
      `core.hooksPath=${disabledHooks}`,
      "apply",
      "--whitespace=nowarn",
      "--",
      patchPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
};

const recoveryEntry = (
  entries: readonly MigrationRecoveryJournalEntry[],
  checkpoint: MigrationRecoveryJournalEntry["checkpoint"],
): MigrationRecoveryJournalEntry => {
  const entry = entries.find((item) => item.checkpoint === checkpoint);
  if (!entry)
    throw new MigrationSafetyError(
      `Recovery checkpoint ${checkpoint} is missing`,
      12,
      "recovery-checkpoint-missing",
    );
  return entry;
};

export interface ResumeMigrationInput {
  repositoryRoot: string;
  executionId: string;
  proposal: MigrationProposal;
  snapshot: ArchitectureSnapshot;
  config: ArchitectureConfig;
  migrationExecutor: MigrationExecutor;
  executionRoot?: string;
  journalStore?: RecoveryJournalStore;
  executionStore?: ExecutionStore;
  worktreeManager?: WorktreeManager;
  now?: () => Date;
}

export const resumeMigration = async (
  input: ResumeMigrationInput,
): Promise<MigrationRunResult> => {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const executionRoot =
    input.executionRoot ?? defaultExecutionRoot(repositoryRoot);
  const journalStore =
    input.journalStore ?? new JsonRecoveryJournalStore(repositoryRoot);
  const executionStore =
    input.executionStore ?? new JsonExecutionStore(repositoryRoot);
  const manager =
    input.worktreeManager ??
    new WorktreeManager({ repositoryRoot, executionRoot });
  const initialReport = await inspectMigrationRecovery({
    repositoryRoot,
    executionRoot,
    executionId: input.executionId,
    journalStore,
    executionStore,
    worktreeManager: manager,
  });
  if (initialReport.classification === "already-complete") {
    const [plan, record] = await Promise.all([
      executionStore.loadPlan(input.executionId),
      executionStore.loadRecord(input.executionId),
    ]);
    return { executionId: input.executionId, plan, record };
  }
  assertResumable(initialReport);
  const initialJournal = await journalStore.loadJournal(input.executionId);
  const first = initialJournal.entries[0];
  if (!first || !initialJournal.integrity.valid)
    throw new MigrationSafetyError(
      "Recovery journal integrity is invalid",
      12,
      "recovery-journal-integrity-failed",
    );
  const lock = await acquireExecutionLock({
    projectRoot: repositoryRoot,
    executionId: input.executionId,
    repositoryId: first.identity.repositoryId,
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    const lockedReport = await inspectMigrationRecovery({
      repositoryRoot,
      executionRoot,
      executionId: input.executionId,
      journalStore,
      executionStore,
      worktreeManager: manager,
      ownedLockToken: lock.owner.token,
    });
    assertResumable(lockedReport);
    let journal = await journalStore.loadJournal(input.executionId);
    const semanticBefore = recoveryHash(
      initialJournal.entries.map(({ semanticHash }) => semanticHash),
    );
    if (
      semanticBefore !==
      recoveryHash(journal.entries.map(({ semanticHash }) => semanticHash))
    )
      throw new MigrationSafetyError(
        "Recovery journal changed before lock acquisition",
        12,
        "recovery-journal-changed",
      );
    const plan = await executionStore.loadPlan(input.executionId);
    let record = await executionStore.loadRecord(input.executionId);
    if (
      plan.planId !== first.planId ||
      plan.proposalId !== input.proposal.id ||
      plan.repository.snapshotId !== input.snapshot.id ||
      plan.repository.configHash !== executionConfigHash(input.config) ||
      plan.repository.sourceFingerprint !== input.snapshot.sourceFingerprint ||
      first.identity.approvalHash !== recoveryHash(input.proposal.id) ||
      first.identity.proposalHash !== recoveryHash(input.proposal) ||
      first.identity.configHash !== plan.repository.configHash ||
      first.identity.sourceFingerprint !== plan.repository.sourceFingerprint ||
      input.migrationExecutor.kind !== plan.executor.kind
    )
      throw new MigrationSafetyError(
        "Resume input does not match the durable execution identity",
        12,
        "recovery-input-mismatch",
      );
    const context = journalContextFrom(first);
    const now = input.now ?? (() => new Date());
    const append = async (
      evidence: Parameters<typeof appendRecoveryCheckpoint>[0]["evidence"],
    ): Promise<void> => {
      await appendRecoveryCheckpoint({
        context,
        store: journalStore,
        now,
        evidence,
      });
      journal = await journalStore.loadJournal(input.executionId);
    };
    const planned = recoveryEntry(journal.entries, "planned");
    if (planned.evidence.checkpoint !== "planned")
      throw new MigrationSafetyError(
        "Planned recovery evidence is invalid",
        12,
        "recovery-planned-invalid",
      );
    const processResource = planned.evidence.resources.find(
      ({ resourceType }) => resourceType === "process-metadata",
    );
    const indexResource = planned.evidence.resources.find(
      ({ resourceType }) => resourceType === "candidate-index",
    );
    const latest = (): MigrationRecoveryJournalEntry["checkpoint"] =>
      journal.entries.at(-1)!.checkpoint;
    const terminalFailure = async (input_: {
      stage: string;
      code: string;
      message: string;
      status:
        | "executor-failed"
        | "no-changes"
        | "scope-violation"
        | "validation-failed"
        | "needs-review";
    }): Promise<never> => {
      await append({
        checkpoint: "failed",
        stage: input_.stage,
        code: input_.code,
        outcomeHash: recoveryHash(input_),
      });
      const ownedGitDirectory = await manager
        .gitDirectory(input.executionId)
        .catch(() => undefined);
      const main = await captureMainCheckoutState(repositoryRoot, {
        ownedCandidateRef: `refs/heads/${candidateBranchForExecution(input.executionId)}`,
        ...(ownedGitDirectory
          ? { ownedWorktreeGitDirectory: ownedGitDirectory }
          : {}),
      });
      record = migrationExecutionRecordSchema.parse({
        ...record,
        status: input_.status,
        completedAt: now().toISOString(),
        fingerprints: { ...record.fingerprints, mainAfter: main.fingerprint },
        failure: {
          stage: input_.stage,
          code: input_.code,
          message: input_.message,
        },
      });
      await executionStore.saveRecord(record);
      throw new MigrationSafetyError(
        input_.message,
        input_.stage === "scope"
          ? 8
          : input_.stage === "validation"
            ? 9
            : input_.stage === "architecture"
              ? 10
              : 7,
        input_.code,
      );
    };

    if (latest() === "planned") {
      const preflight = await runPreflight({
        repositoryRoot,
        proposal: input.proposal,
        snapshot: input.snapshot,
        config: input.config,
        approval: input.proposal.id,
        requireApproval: true,
      });
      if (
        preflight.baseCommit !== plan.repository.baseCommit ||
        preflight.sourceFingerprint !== plan.repository.sourceFingerprint ||
        plan.readiness?.state === "not-ready"
      )
        throw new MigrationSafetyError(
          "Preflight evidence no longer matches the approved plan",
          12,
          "recovery-preflight-mismatch",
        );
      await append({
        checkpoint: "preflight-passed",
        freshnessHash: recoveryHash({
          baseCommit: preflight.baseCommit,
          sourceFingerprint: preflight.sourceFingerprint,
          configHash: plan.repository.configHash,
        }),
        preflightHash: recoveryHash({
          approval: input.proposal.id,
          proposalId: plan.proposalId,
          readiness: plan.readiness,
        }),
      });
    }

    if (latest() === "preflight-passed") {
      let owned = await manager.load(input.executionId).catch(() => undefined);
      if (!owned)
        owned = await manager.create(
          input.executionId,
          plan.repository.baseCommit,
          {
            proposalId: plan.proposalId,
            planId: plan.planId,
            repositoryId: first.identity.repositoryId,
          },
        );
      await manager.assertOwnedState(
        input.executionId,
        plan.repository.baseCommit,
      );
      if (record.status === "planned") {
        record = migrationExecutionRecordSchema.parse({
          ...record,
          status: "worktree-created",
          candidateBranch: owned.branch,
        });
        await executionStore.saveRecord(record);
      }
      const stagingPath = durableExecutorStagingPath(
        executionRoot,
        input.executionId,
      );
      let staging: ExecutorStagingRepository;
      if (await exists(stagingPath)) {
        const marker = await readJson<{ markerHash: string }>(
          path.join(stagingPath, "ownership.json"),
        );
        staging = await loadExecutorStagingRepository({
          containerPath: stagingPath,
          executionId: input.executionId,
          repositoryId: first.identity.repositoryId,
          baseCommit: plan.repository.baseCommit,
          expectedMarkerHash: marker.markerHash,
        });
      } else
        staging = await createExecutorStagingRepository(
          repositoryRoot,
          plan.repository.baseCommit,
          {
            containerPath: stagingPath,
            executionId: input.executionId,
            repositoryId: first.identity.repositoryId,
            relativeLocator: `staging/${input.executionId}`,
          },
        );
      if (
        !staging.durableIdentity ||
        !owned.ownershipHash ||
        !owned.worktreeGitDirectoryId
      )
        throw new MigrationSafetyError(
          "Recovery resources lack durable ownership evidence",
          12,
          "recovery-ownership-missing",
        );
      const candidateRef = `refs/heads/${owned.branch}`;
      await append({
        checkpoint: "staging-created",
        stagingResource: createResourceOwnership({
          resourceType: "staging-repository",
          executionId: input.executionId,
          repositoryId: first.identity.repositoryId,
          baseCommit: plan.repository.baseCommit,
          portableLocator: `staging/${input.executionId}`,
          creationCheckpoint: "staging-created",
          integrityHash: staging.durableIdentity.markerHash,
          gitIdentity: {
            commonDirectoryId: staging.durableIdentity.repositoryGitDirectoryId,
            head: plan.repository.baseCommit,
          },
        }),
        candidateWorktreeResource: createResourceOwnership({
          resourceType: "candidate-worktree",
          executionId: input.executionId,
          repositoryId: first.identity.repositoryId,
          baseCommit: plan.repository.baseCommit,
          portableLocator: `worktrees/${input.executionId}`,
          creationCheckpoint: "staging-created",
          integrityHash: owned.ownershipHash,
          gitIdentity: {
            commonDirectoryId: first.identity.gitCommonDirectoryId,
            worktreeId: owned.worktreeGitDirectoryId,
            head: plan.repository.baseCommit,
          },
        }),
        candidateRefResource: createResourceOwnership({
          resourceType: "candidate-ref",
          executionId: input.executionId,
          repositoryId: first.identity.repositoryId,
          baseCommit: plan.repository.baseCommit,
          portableLocator: candidateRef,
          creationCheckpoint: "staging-created",
          integrityHash: recoveryHash({
            executionId: input.executionId,
            repositoryId: first.identity.repositoryId,
            baseCommit: plan.repository.baseCommit,
            ref: candidateRef,
            initialReflog: owned.initialReflog,
          }),
          gitIdentity: {
            commonDirectoryId: first.identity.gitCommonDirectoryId,
            worktreeId: owned.worktreeGitDirectoryId,
            head: plan.repository.baseCommit,
            ref: candidateRef,
          },
        }),
        markerHash: staging.durableIdentity.markerHash,
        initialCommit: plan.repository.baseCommit,
        noRemotes: true,
      });
    }

    if (latest() === "staging-created") {
      if (!processResource)
        throw new MigrationSafetyError(
          "Executor process ownership intent is missing",
          12,
          "recovery-process-ownership-missing",
        );
      const stagingCheckpoint = recoveryEntry(
        journal.entries,
        "staging-created",
      );
      if (stagingCheckpoint.evidence.checkpoint !== "staging-created")
        throw new MigrationSafetyError(
          "Staging checkpoint evidence is invalid",
          12,
          "recovery-staging-invalid",
        );
      const staging = await loadExecutorStagingRepository({
        containerPath: durableExecutorStagingPath(
          executionRoot,
          input.executionId,
        ),
        executionId: input.executionId,
        repositoryId: first.identity.repositoryId,
        baseCommit: plan.repository.baseCommit,
        expectedMarkerHash: stagingCheckpoint.evidence.markerHash,
      });
      if (
        (await createSourceFingerprint(staging.repositoryPath)).hash !==
        plan.repository.sourceFingerprint
      )
        throw new MigrationSafetyError(
          "Staging source changed before executor launch",
          12,
          "recovery-staging-source-mismatch",
        );
      const environment = await input.migrationExecutor.inspect();
      if (record.status === "worktree-created") {
        record = migrationExecutionRecordSchema.parse({
          ...record,
          status: "running",
          executor: {
            ...record.executor,
            ...(environment.executableVersion
              ? { executableVersion: environment.executableVersion }
              : {}),
            sandbox: environment.sandbox,
          },
        });
        await executionStore.saveRecord(record);
      }
      await executionStore.writeJsonArtifact(
        input.executionId,
        "recovery/executor-process.json",
        createRecoveryProcessMetadata(processResource, "prepared"),
      );
      const invocationConfigurationHash = recoveryHash(plan.executor);
      await append({
        checkpoint: "executor-started",
        invocationId: planned.evidence.executorInvocationId,
        configurationHash: invocationConfigurationHash,
        kind: plan.executor.kind,
        timeoutMs: plan.executor.timeoutMs,
        sandbox: "workspace-write",
        processResource,
      });
      const processPath = path.join(
        repositoryRoot,
        processResource.portableLocator,
      );
      if (
        (await processMetadataState(processPath, processResource)) !==
        "prepared"
      )
        throw new MigrationSafetyError(
          "Executor process ownership marker changed",
          12,
          "recovery-process-ownership-invalid",
        );
      await transitionProcessMetadata(
        processPath,
        processResource,
        "prepared",
        "launching",
      );

      let executorResult: ExecutorResult;
      try {
        executorResult = await input.migrationExecutor.execute(plan, {
          worktreePath: staging.repositoryPath,
          prompt: buildMigrationPrompt(plan),
          timeoutMs: plan.executor.timeoutMs,
        });
      } catch (error) {
        await staging.assertGitState();
        await manager.assertOwnedState(
          input.executionId,
          plan.repository.baseCommit,
        );
        throw error;
      }
      await staging.assertGitState();
      await manager.assertOwnedState(
        input.executionId,
        plan.repository.baseCommit,
      );
      const stagingFingerprint = (
        await createSourceFingerprint(staging.repositoryPath)
      ).hash;
      const privatePaths = [repositoryRoot, staging.repositoryPath];
      const durableResult = sanitizeExecutorResult(
        executorResult,
        planned.evidence.executorInvocationId,
        stagingFingerprint,
        privatePaths,
      );
      const eventLog = await executionStore.writeTextArtifact(
        input.executionId,
        "codex-events.jsonl",
        durableResult.events.length > 0
          ? `${durableResult.events.map((event) => JSON.stringify(event)).join("\n")}\n`
          : "",
      );
      await executionStore.writeTextArtifact(
        input.executionId,
        "codex-stderr.log",
        durableResult.stderr,
      );
      if (durableResult.summary)
        await executionStore.writeJsonArtifact(
          input.executionId,
          "codex-summary.json",
          durableResult.summary,
        );
      await executionStore.writeJsonArtifact(
        input.executionId,
        "recovery/executor-result.json",
        { ...durableResult, eventLog },
      );
      await append(executorFinishedEvidenceFor(durableResult));
      await removeOwnedProcessMetadata(
        processPath,
        processResource,
        "launching",
      );
    }

    if (latest() === "executor-finished") {
      const executorFinished = recoveryEntry(
        journal.entries,
        "executor-finished",
      );
      const stagingCreated = recoveryEntry(journal.entries, "staging-created");
      if (
        executorFinished.evidence.checkpoint !== "executor-finished" ||
        stagingCreated.evidence.checkpoint !== "staging-created"
      )
        throw new MigrationSafetyError(
          "Executor recovery evidence is invalid",
          12,
          "recovery-executor-evidence-invalid",
        );
      const durableResult = await loadVerifiedExecutorResult(
        repositoryRoot,
        input.executionId,
        executorFinished,
      );
      if (processResource) {
        const processPath = path.join(
          repositoryRoot,
          processResource.portableLocator,
        );
        if (await exists(processPath))
          await removeOwnedProcessMetadata(
            processPath,
            processResource,
            "launching",
          );
      }
      record = migrationExecutionRecordSchema.parse({
        ...record,
        executor: {
          ...record.executor,
          ...(durableResult.exitCode === null
            ? {}
            : { exitCode: durableResult.exitCode }),
          timedOut: durableResult.timedOut,
          ...(usageFromEvents(durableResult.events)
            ? { usage: usageFromEvents(durableResult.events) }
            : {}),
        },
        artifacts: {
          ...record.artifacts,
          eventLog: recoveryArtifactLocator(
            input.executionId,
            "../codex-events.jsonl",
          ).replace("/recovery/../", "/"),
          ...(durableResult.summary
            ? {
                finalSummary: recoveryArtifactLocator(
                  input.executionId,
                  "../codex-summary.json",
                ).replace("/recovery/../", "/"),
              }
            : {}),
        },
      });
      if (
        durableResult.timedOut ||
        durableResult.exitCode !== 0 ||
        (plan.executor.kind === "codex" && !durableResult.summary)
      )
        return terminalFailure({
          stage: "executor",
          code: durableResult.timedOut
            ? "executor-timeout"
            : durableResult.exitCode !== 0
              ? "executor-nonzero-exit"
              : "executor-summary-invalid",
          message: "Durable executor result is not successful",
          status: "executor-failed",
        });
      const staging = await loadExecutorStagingRepository({
        containerPath: durableExecutorStagingPath(
          executionRoot,
          input.executionId,
        ),
        executionId: input.executionId,
        repositoryId: first.identity.repositoryId,
        baseCommit: plan.repository.baseCommit,
        expectedMarkerHash: stagingCreated.evidence.markerHash,
      });
      const stagedFingerprint = await createSourceFingerprint(
        staging.repositoryPath,
      );
      if (stagedFingerprint.hash !== durableResult.stagingFingerprint)
        throw new MigrationSafetyError(
          "Staging output no longer matches executor-finished evidence",
          12,
          "recovery-staging-output-mismatch",
        );
      const scope = await inspectMigrationScope({
        worktreeRoot: staging.repositoryPath,
        plan,
        publicEntrypoints: input.snapshot.repository.publicEntrypoints,
      });
      if (scope.changedFiles.length === 0)
        return terminalFailure({
          stage: "scope",
          code: "no-changes",
          message: "Migration executor made no source changes",
          status: "no-changes",
        });
      if (!scope.compliant)
        return terminalFailure({
          stage: "scope",
          code: "scope-violation",
          message: "Migration diff violates the approved scope",
          status: "scope-violation",
        });
      const patchArtifact = await executionStore.writeTextArtifact(
        input.executionId,
        "candidate.patch",
        scope.patch,
      );
      const patchResource = createResourceOwnership({
        resourceType: "patch-artifact",
        executionId: input.executionId,
        repositoryId: first.identity.repositoryId,
        baseCommit: plan.repository.baseCommit,
        portableLocator: patchArtifact,
        creationCheckpoint: "patch-captured",
        integrityHash: recoveryHash(scope.patch),
      });
      await append({
        checkpoint: "patch-captured",
        patchHash: scope.patchHash,
        stagingFingerprint: durableResult.stagingFingerprint,
        changedFiles: scope.changedFiles,
        modes: await capturePatchFileModes(
          staging.repositoryPath,
          plan.repository.baseCommit,
          scope.changedFiles,
        ),
        patchResource,
      });
    }

    if (latest() === "patch-captured") {
      const patchCaptured = recoveryEntry(journal.entries, "patch-captured");
      const stagingCreated = recoveryEntry(journal.entries, "staging-created");
      if (
        patchCaptured.evidence.checkpoint !== "patch-captured" ||
        stagingCreated.evidence.checkpoint !== "staging-created"
      )
        throw new MigrationSafetyError(
          "Patch recovery evidence is invalid",
          12,
          "recovery-patch-evidence-invalid",
        );
      const owned = await manager.load(input.executionId);
      await manager.assertOwnedState(
        input.executionId,
        plan.repository.baseCommit,
      );
      let scope = await inspectMigrationScope({
        worktreeRoot: owned.worktreePath,
        plan,
        publicEntrypoints: input.snapshot.repository.publicEntrypoints,
      });
      if (scope.changedFiles.length === 0) {
        const stagingPath = durableExecutorStagingPath(
          executionRoot,
          input.executionId,
        );
        if (await exists(stagingPath)) {
          const staging = await loadExecutorStagingRepository({
            containerPath: stagingPath,
            executionId: input.executionId,
            repositoryId: first.identity.repositoryId,
            baseCommit: plan.repository.baseCommit,
            expectedMarkerHash: stagingCreated.evidence.markerHash,
          });
          if (
            (await createSourceFingerprint(staging.repositoryPath)).hash !==
            patchCaptured.evidence.stagingFingerprint
          )
            throw new MigrationSafetyError(
              "Staging output changed after patch capture",
              12,
              "recovery-staging-output-mismatch",
            );
          await staging.materialize(
            owned.worktreePath,
            patchCaptured.evidence.changedFiles,
          );
          await staging.dispose();
        } else
          await applyPatchArtifact(
            owned.worktreePath,
            path.resolve(
              repositoryRoot,
              patchCaptured.evidence.patchResource.portableLocator,
            ),
          );
        scope = await inspectMigrationScope({
          worktreeRoot: owned.worktreePath,
          plan,
          publicEntrypoints: input.snapshot.repository.publicEntrypoints,
        });
      } else {
        const stagingPath = durableExecutorStagingPath(
          executionRoot,
          input.executionId,
        );
        if (await exists(stagingPath)) {
          const staging = await loadExecutorStagingRepository({
            containerPath: stagingPath,
            executionId: input.executionId,
            repositoryId: first.identity.repositoryId,
            baseCommit: plan.repository.baseCommit,
            expectedMarkerHash: stagingCreated.evidence.markerHash,
          });
          await staging.dispose();
        }
      }
      if (
        !scope.compliant ||
        scope.patchHash !== patchCaptured.evidence.patchHash ||
        recoveryHash(scope.patch) !==
          patchCaptured.evidence.patchResource.integrityHash ||
        recoveryHash(scope.changedFiles) !==
          recoveryHash(patchCaptured.evidence.changedFiles)
      )
        throw new MigrationSafetyError(
          "Materialized candidate does not match captured patch evidence",
          12,
          "recovery-patch-materialization-mismatch",
        );
      await executionStore.writeJsonArtifact(
        input.executionId,
        "scope.json",
        withoutPatch(scope),
      );
      await append({
        checkpoint: "scope-verified",
        inputHash: recoveryHash({
          patchHash: scope.patchHash,
          changedFiles: scope.changedFiles,
          planId: plan.planId,
        }),
        resultHash: recoveryHash(withoutPatch(scope)),
        accepted: true,
      });
    }

    if (latest() === "scope-verified") {
      const owned = await manager.load(input.executionId);
      await manager.assertOwnedState(
        input.executionId,
        plan.repository.baseCommit,
      );
      const validation = await runValidationCommands({
        worktreeRoot: owned.worktreePath,
        commands: plan.validation.commands,
      });
      const results = validation.results.map((result) =>
        validationResultSchema.parse({
          ...result,
          stdout: sanitizePortable(result.stdout, [
            repositoryRoot,
            owned.worktreePath,
          ]),
          stderr: sanitizePortable(result.stderr, [
            repositoryRoot,
            owned.worktreePath,
          ]),
        }),
      );
      await executionStore.writeJsonArtifact(
        input.executionId,
        "validation.json",
        { passed: validation.passed, results },
      );
      await manager.assertOwnedState(
        input.executionId,
        plan.repository.baseCommit,
      );
      const scope = await inspectMigrationScope({
        worktreeRoot: owned.worktreePath,
        plan,
        publicEntrypoints: input.snapshot.repository.publicEntrypoints,
      });
      const patchCaptured = recoveryEntry(journal.entries, "patch-captured");
      if (
        patchCaptured.evidence.checkpoint !== "patch-captured" ||
        scope.patchHash !== patchCaptured.evidence.patchHash ||
        !scope.compliant
      )
        return terminalFailure({
          stage: "scope",
          code: "post-validation-scope-violation",
          message: "Validation changed the captured candidate patch",
          status: "scope-violation",
        });
      if (!validation.passed)
        return terminalFailure({
          stage: "validation",
          code: "required-validation-failed",
          message: "A required migration validation command failed",
          status: "validation-failed",
        });
      await append({
        checkpoint: "validation-passed",
        inputHash: recoveryHash({
          patchHash: scope.patchHash,
          candidate: await candidateFingerprint(
            owned.worktreePath,
            scope.patchHash,
          ),
        }),
        commandsHash: recoveryHash(plan.validation.commands),
        resultHashes: results.map((result) => recoveryHash(result)),
      });
    }

    if (latest() === "validation-passed") {
      const owned = await manager.load(input.executionId);
      await manager.assertOwnedState(
        input.executionId,
        plan.repository.baseCommit,
      );
      const beforeScope = await inspectMigrationScope({
        worktreeRoot: owned.worktreePath,
        plan,
        publicEntrypoints: input.snapshot.repository.publicEntrypoints,
      });
      const patchCaptured = recoveryEntry(journal.entries, "patch-captured");
      if (
        patchCaptured.evidence.checkpoint !== "patch-captured" ||
        !beforeScope.compliant ||
        beforeScope.patchHash !== patchCaptured.evidence.patchHash
      )
        throw new MigrationSafetyError(
          "Candidate changed before architecture validation",
          12,
          "recovery-candidate-changed",
        );
      const afterAnalysis = await analyzeRepository(
        owned.worktreePath,
        input.config,
      );
      const afterSnapshot = createArchitectureSnapshot({
        projectRoot: owned.worktreePath,
        gitCommit: plan.repository.baseCommit,
        configHash: configHash(input.config),
        migrationConfigHash: migrationConfigHash(input.config),
        sourceFingerprint: await candidateFingerprint(
          owned.worktreePath,
          beforeScope.patchHash,
        ),
        repository: afterAnalysis.repository,
        metrics: afterAnalysis.metrics,
        createdAt: now(),
      });
      const publicEntrypoints = [
        ...new Set([
          ...input.snapshot.repository.publicEntrypoints,
          ...afterSnapshot.repository.publicEntrypoints,
        ]),
      ].sort((left, right) => left.localeCompare(right));
      let scope = await inspectMigrationScope({
        worktreeRoot: owned.worktreePath,
        plan,
        publicEntrypoints,
      });
      const [surfaceBefore, surfaceAfter] = await Promise.all([
        captureSafetySurface({
          repositoryRoot,
          publicEntrypoints,
          snapshot: input.snapshot,
        }),
        captureSafetySurface({
          repositoryRoot: owned.worktreePath,
          publicEntrypoints,
          snapshot: afterSnapshot,
        }),
      ]);
      scope = mergeScopeViolations(
        scope,
        compareSafetySurfaces(surfaceBefore, surfaceAfter),
      );
      if (!scope.compliant)
        return terminalFailure({
          stage: "scope",
          code: "safety-surface-violation",
          message:
            "Dependency, configuration, or public API safety surface changed",
          status: "scope-violation",
        });
      const architecture = compareMigrationImpact({
        plan,
        before: input.snapshot,
        after: afterSnapshot,
        changedFiles: scope.changedFiles,
        protectedPaths: input.config.protected_paths,
      });
      if (!architecture.passed)
        return terminalFailure({
          stage: "architecture",
          code: "architecture-validation-failed",
          message: `Architecture validation failed: ${architecture.failures.join(", ")}`,
          status: "needs-review",
        });
      const finalScope = await inspectMigrationScope({
        worktreeRoot: owned.worktreePath,
        plan,
        publicEntrypoints,
      });
      if (
        !finalScope.compliant ||
        finalScope.patchHash !== scope.patchHash ||
        recoveryHash(finalScope.changedFiles) !==
          recoveryHash(scope.changedFiles) ||
        (await candidateFingerprint(
          owned.worktreePath,
          finalScope.patchHash,
        )) !== afterSnapshot.sourceFingerprint
      )
        throw new MigrationSafetyError(
          "Candidate changed during architecture validation",
          12,
          "recovery-candidate-changed",
        );
      await Promise.all([
        executionStore.writeJsonArtifact(
          input.executionId,
          "scope.json",
          withoutPatch(finalScope),
        ),
        executionStore.writeJsonArtifact(
          input.executionId,
          "architecture-before.json",
          portableSnapshot(input.snapshot),
        ),
        executionStore.writeJsonArtifact(
          input.executionId,
          "architecture-after.json",
          portableSnapshot(afterSnapshot),
        ),
        executionStore.writeJsonArtifact(
          input.executionId,
          "impact-comparison.json",
          architecture,
        ),
      ]);
      const validationArtifact = await readJson<{
        passed: boolean;
        results: ValidationResult[];
      }>(artifactPath(repositoryRoot, input.executionId, "validation.json"));
      await append({
        checkpoint: "architecture-passed",
        inputHash: recoveryHash({
          beforeSnapshotId: input.snapshot.id,
          afterSnapshotId: afterSnapshot.id,
          patchHash: finalScope.patchHash,
          validation: validationArtifact.results.map((result) =>
            recoveryHash(result),
          ),
        }),
        resultHash: recoveryHash(architecture),
        accepted: true,
      });
    }

    if (latest() === "architecture-passed" && planned.evidence.createCommit) {
      if (!indexResource)
        throw new MigrationSafetyError(
          "Candidate index ownership intent is missing",
          12,
          "recovery-index-ownership-missing",
        );
      const indexDirectory = path.join(
        recoveryDirectory(repositoryRoot, input.executionId),
        "candidate-index",
      );
      if (await exists(indexDirectory)) {
        if (
          !(await ownershipMarkerMatches(
            path.join(indexDirectory, "ownership.json"),
            indexResource,
          ))
        )
          throw new MigrationSafetyError(
            "Candidate index ownership is ambiguous",
            12,
            "recovery-index-ownership-invalid",
          );
        await rm(indexDirectory, { recursive: true });
      }
      const owned = await manager.load(input.executionId);
      const scope = await inspectMigrationScope({
        worktreeRoot: owned.worktreePath,
        plan,
        publicEntrypoints: [
          ...new Set([
            ...input.snapshot.repository.publicEntrypoints,
            ...(
              await readJson<ArchitectureSnapshot>(
                artifactPath(
                  repositoryRoot,
                  input.executionId,
                  "architecture-after.json",
                ),
              )
            ).repository.publicEntrypoints,
          ]),
        ],
      });
      const patchCaptured = recoveryEntry(journal.entries, "patch-captured");
      if (
        patchCaptured.evidence.checkpoint !== "patch-captured" ||
        !scope.compliant ||
        scope.patchHash !== patchCaptured.evidence.patchHash
      )
        throw new MigrationSafetyError(
          "Candidate changed before deterministic commit preparation",
          12,
          "recovery-candidate-changed",
        );
      const preparation = await prepareCandidateCommit({
        worktreePath: owned.worktreePath,
        baseCommit: plan.repository.baseCommit,
        candidateBranch: owned.branch,
        proposalId: plan.proposalId,
        executionId: input.executionId,
        planId: plan.planId,
        changedFiles: scope.changedFiles,
        expectedPatchHash: scope.patchHash,
        timestamp: Math.floor(Date.parse(record.startedAt) / 1_000),
        indexDirectory,
        indexOwnership: indexResource,
      });
      await executionStore.writeJsonArtifact(
        input.executionId,
        "recovery/candidate-preparation.json",
        preparation,
      );
      await append({
        checkpoint: "candidate-prepared",
        parent: preparation.parent,
        tree: preparation.tree,
        message: preparation.message,
        author: {
          name: preparation.authorName,
          email: preparation.authorEmail,
        },
        committer: {
          name: preparation.committerName,
          email: preparation.committerEmail,
        },
        timestamp: preparation.timestamp,
        timezone: preparation.timezone,
        ref: preparation.ref,
        expectedCommit: preparation.expectedCommit,
        indexResource,
        createCommit: true,
      });
    }

    if (latest() === "candidate-prepared") {
      const prepared = recoveryEntry(journal.entries, "candidate-prepared");
      if (prepared.evidence.checkpoint !== "candidate-prepared")
        throw new MigrationSafetyError(
          "Candidate preparation checkpoint is invalid",
          12,
          "recovery-candidate-preparation-invalid",
        );
      const preparation = await readJson<CandidateCommitPreparation>(
        artifactPath(
          repositoryRoot,
          input.executionId,
          "recovery/candidate-preparation.json",
        ),
      );
      if (
        recoveryHash({
          parent: preparation.parent,
          tree: preparation.tree,
          message: preparation.message,
          author: {
            name: preparation.authorName,
            email: preparation.authorEmail,
          },
          committer: {
            name: preparation.committerName,
            email: preparation.committerEmail,
          },
          timestamp: preparation.timestamp,
          timezone: preparation.timezone,
          ref: preparation.ref,
          expectedCommit: preparation.expectedCommit,
        }) !==
        recoveryHash({
          parent: prepared.evidence.parent,
          tree: prepared.evidence.tree,
          message: prepared.evidence.message,
          author: prepared.evidence.author,
          committer: prepared.evidence.committer,
          timestamp: prepared.evidence.timestamp,
          timezone: prepared.evidence.timezone,
          ref: prepared.evidence.ref,
          expectedCommit: prepared.evidence.expectedCommit,
        })
      )
        throw new MigrationSafetyError(
          "Candidate preparation artifact conflicts with the journal",
          12,
          "recovery-candidate-preparation-mismatch",
        );
      const owned = await manager.load(input.executionId);
      const commit = await createPreparedCandidateCommit({
        worktreePath: owned.worktreePath,
        preparation,
      });
      await manager.recordCandidateCommit(input.executionId, commit);
      await manager.assertOwnedState(input.executionId, commit);
      await append({
        checkpoint: "candidate-created",
        commit,
        tree: preparation.tree,
        parent: preparation.parent,
        ref: preparation.ref,
        verified: true,
        verificationHash: recoveryHash({ preparation, commit }),
      });
    }

    if (
      latest() === "candidate-created" ||
      (latest() === "architecture-passed" && !planned.evidence.createCommit)
    ) {
      if (record.status !== "succeeded") {
        const owned = await manager.load(input.executionId);
        const candidateCreated = checkpointEntry(
          journal.entries,
          "candidate-created",
        );
        const expectedCommit =
          candidateCreated?.evidence.checkpoint === "candidate-created"
            ? candidateCreated.evidence.commit
            : plan.repository.baseCommit;
        await manager.assertOwnedState(input.executionId, expectedCommit);
        const afterSnapshot = architectureSnapshotSchema.parse(
          await readJson(
            artifactPath(
              repositoryRoot,
              input.executionId,
              "architecture-after.json",
            ),
          ),
        );
        const architecture = await readJson<{
          passed: boolean;
          impact: MigrationArchitectureImpact;
          comparison: ImpactComparison;
          failures: string[];
        }>(
          artifactPath(
            repositoryRoot,
            input.executionId,
            "impact-comparison.json",
          ),
        );
        const validationArtifact = await readJson<{
          passed: boolean;
          results: ValidationResult[];
        }>(artifactPath(repositoryRoot, input.executionId, "validation.json"));
        const validationResults = validationArtifact.results.map((result) =>
          validationResultSchema.parse(result),
        );
        const patchCaptured = recoveryEntry(journal.entries, "patch-captured");
        const validationCheckpoint = recoveryEntry(
          journal.entries,
          "validation-passed",
        );
        const scopeCheckpoint = recoveryEntry(
          journal.entries,
          "scope-verified",
        );
        const architectureCheckpoint = recoveryEntry(
          journal.entries,
          "architecture-passed",
        );
        const durableScope = await readJson<Omit<ScopeInspection, "patch">>(
          artifactPath(repositoryRoot, input.executionId, "scope.json"),
        );
        const patchContents = await readFile(
          path.resolve(
            repositoryRoot,
            patchCaptured.evidence.checkpoint === "patch-captured"
              ? patchCaptured.evidence.patchResource.portableLocator
              : "",
          ),
          "utf8",
        );
        const liveScope =
          candidateCreated?.evidence.checkpoint === "candidate-created"
            ? undefined
            : await inspectMigrationScope({
                worktreeRoot: owned.worktreePath,
                plan,
                publicEntrypoints: [
                  ...new Set([
                    ...input.snapshot.repository.publicEntrypoints,
                    ...afterSnapshot.repository.publicEntrypoints,
                  ]),
                ],
              });
        if (candidateCreated?.evidence.checkpoint === "candidate-created") {
          const prepared = recoveryEntry(journal.entries, "candidate-prepared");
          if (
            prepared.evidence.checkpoint !== "candidate-prepared" ||
            candidateCreated.evidence.commit !==
              prepared.evidence.expectedCommit ||
            candidateCreated.evidence.parent !== prepared.evidence.parent ||
            candidateCreated.evidence.tree !== prepared.evidence.tree ||
            candidateCreated.evidence.ref !== prepared.evidence.ref ||
            (await git(repositoryRoot, [
              "rev-parse",
              candidateCreated.evidence.ref,
            ])) !== candidateCreated.evidence.commit ||
            (await git(repositoryRoot, [
              "rev-parse",
              `${candidateCreated.evidence.commit}^`,
            ])) !== candidateCreated.evidence.parent ||
            (await git(repositoryRoot, [
              "rev-parse",
              `${candidateCreated.evidence.commit}^{tree}`,
            ])) !== candidateCreated.evidence.tree
          )
            throw new MigrationSafetyError(
              "Created candidate does not match deterministic preparation",
              12,
              "recovery-candidate-evidence-invalid",
            );
        }
        if (
          !architecture.passed ||
          !validationArtifact.passed ||
          patchCaptured.evidence.checkpoint !== "patch-captured" ||
          scopeCheckpoint.evidence.checkpoint !== "scope-verified" ||
          validationCheckpoint.evidence.checkpoint !== "validation-passed" ||
          architectureCheckpoint.evidence.checkpoint !==
            "architecture-passed" ||
          recoveryHash(architecture) !==
            architectureCheckpoint.evidence.resultHash ||
          recoveryHash(plan.validation.commands) !==
            validationCheckpoint.evidence.commandsHash ||
          recoveryHash(
            validationResults.map((result) => recoveryHash(result)),
          ) !== recoveryHash(validationCheckpoint.evidence.resultHashes) ||
          recoveryHash(durableScope) !== scopeCheckpoint.evidence.resultHash ||
          !durableScope.compliant ||
          durableScope.patchHash !== patchCaptured.evidence.patchHash ||
          recoveryHash(durableScope.changedFiles) !==
            recoveryHash(patchCaptured.evidence.changedFiles) ||
          recoveryHash(patchContents) !==
            patchCaptured.evidence.patchResource.integrityHash ||
          hashNormalizedPatch(patchContents) !==
            patchCaptured.evidence.patchHash ||
          (liveScope !== undefined &&
            (!liveScope.compliant ||
              liveScope.patchHash !== patchCaptured.evidence.patchHash ||
              recoveryHash(liveScope.changedFiles) !==
                recoveryHash(patchCaptured.evidence.changedFiles)))
        )
          throw new MigrationSafetyError(
            "Final recovery evidence is inconsistent",
            12,
            "recovery-final-evidence-invalid",
          );
        const executorResult = await loadVerifiedExecutorResult(
          repositoryRoot,
          input.executionId,
          recoveryEntry(journal.entries, "executor-finished"),
        );
        const ownedGitDirectory = await manager.gitDirectory(input.executionId);
        const mainAfter = await captureMainCheckoutState(repositoryRoot, {
          ownedCandidateRef: `refs/heads/${owned.branch}`,
          ownedWorktreeGitDirectory: ownedGitDirectory,
        });
        if (mainAfter.fingerprint !== record.fingerprints.mainBefore)
          throw new MigrationSafetyError(
            "Main checkout changed while migration was interrupted",
            11,
            "main-checkout-mutated",
          );
        record = migrationExecutionRecordSchema.parse({
          ...record,
          status: "succeeded",
          completedAt: now().toISOString(),
          candidateBranch: owned.branch,
          ...(candidateCreated?.evidence.checkpoint === "candidate-created"
            ? { candidateCommit: candidateCreated.evidence.commit }
            : {}),
          executor: {
            ...record.executor,
            ...(executorResult.exitCode === null
              ? {}
              : { exitCode: executorResult.exitCode }),
            timedOut: executorResult.timedOut,
            ...(usageFromEvents(executorResult.events)
              ? { usage: usageFromEvents(executorResult.events) }
              : {}),
            sandbox: "workspace-write",
          },
          scope: {
            ...record.scope,
            changedFiles: durableScope.changedFiles,
            addedFiles: durableScope.addedFiles,
            deletedFiles: durableScope.deletedFiles,
            violations: durableScope.violations,
          },
          validation: validationResults,
          architecture: {
            ...record.architecture,
            afterSnapshotId: afterSnapshot.id,
            actualImpact: architecture.impact,
            comparison: architecture.comparison,
          },
          fingerprints: {
            ...record.fingerprints,
            mainAfter: mainAfter.fingerprint,
            candidateAfter: afterSnapshot.sourceFingerprint,
            diffHash: durableScope.patchHash,
          },
          artifacts: {
            eventLog: portableExecutionArtifact(
              input.executionId,
              "codex-events.jsonl",
            ),
            ...(executorResult.summary
              ? {
                  finalSummary: portableExecutionArtifact(
                    input.executionId,
                    "codex-summary.json",
                  ),
                }
              : {}),
            patch: patchCaptured.evidence.patchResource.portableLocator,
            validationReport: portableExecutionArtifact(
              input.executionId,
              "validation.json",
            ),
          },
        });
        await executionStore.saveRecord(record);
      }
      record = await executionStore.loadRecord(input.executionId);
      await append({
        checkpoint: "completed",
        executionRecordHash: recoveryHash(record),
        terminalDisposition: "succeeded",
      });
    }

    if (latest() !== "completed")
      throw new MigrationSafetyError(
        `Resume stopped at unexpected checkpoint ${latest()}`,
        12,
        "recovery-resume-incomplete",
      );
    record = await executionStore.loadRecord(input.executionId);
    return { executionId: input.executionId, plan, record };
  } finally {
    await lock.release();
  }
};
