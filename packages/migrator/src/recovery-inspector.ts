import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  migrationRecoveryReportSchema,
  type MigrationRecoveryCheckpoint,
  type MigrationRecoveryClassification,
  type MigrationRecoveryJournalEntry,
  type MigrationRecoveryReport,
  type MigrationExecutionPlan,
  type MigrationResourceOwnership,
} from "@braid/core";
import {
  JsonExecutionStore,
  JsonRecoveryJournalStore,
  type ExecutionStore,
  type RecoveryJournalStore,
} from "@braid/store";
import { MigrationSafetyError } from "@braid/shared";
import {
  durableExecutorStagingPath,
  loadExecutorStagingRepository,
} from "./executor-staging.js";
import {
  inspectExecutionLock,
  type ExecutionLockInspection,
} from "./execution-lock.js";
import { captureMainCheckoutState } from "./main-integrity.js";
import {
  checkpointEntry,
  latestRecoveryCheckpoint,
  recoveryDirectory,
  recoveryResources,
} from "./recovery-journal.js";
import {
  assertExecutorResultMatchesFinishedEvidence,
  captureRecoveryRepositoryIdentity,
  parseRecoveryProcessMetadata,
  recoveryHash,
  recoveryReportId,
} from "./recovery-support.js";
import { hashNormalizedPatch, inspectMigrationScope } from "./scope-policy.js";
import { createSourceFingerprint } from "./source-fingerprint.js";
import {
  candidateBranchForExecution,
  defaultExecutionRoot,
  WorktreeManager,
} from "./worktree-manager.js";

const execFileAsync = promisify(execFile);

const git = async (root: string, arguments_: string[]): Promise<string> =>
  (
    await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim();

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

interface ResourceInspection {
  ambiguous: string[];
  conflicts: string[];
  existingMutable: MigrationResourceOwnership[];
  processLaunchUncertain: boolean;
}

const evidenceResources = (
  entries: readonly MigrationRecoveryJournalEntry[],
  type: MigrationResourceOwnership["resourceType"],
): MigrationResourceOwnership[] =>
  recoveryResources(entries).filter(
    ({ resourceType }) => resourceType === type,
  );

const inspectResources = async (input: {
  repositoryRoot: string;
  executionRoot: string;
  executionId: string;
  entries: MigrationRecoveryJournalEntry[];
  plan?: MigrationExecutionPlan;
  manager: WorktreeManager;
}): Promise<ResourceInspection> => {
  const ambiguous: string[] = [];
  const conflicts: string[] = [];
  const existingMutable: MigrationResourceOwnership[] = [];
  let processLaunchUncertain = false;
  const latest = latestRecoveryCheckpoint(input.entries);
  const stagingEntry = checkpointEntry(input.entries, "staging-created");
  const patchEntry = checkpointEntry(input.entries, "patch-captured");
  const executorFinishedEntry = checkpointEntry(
    input.entries,
    "executor-finished",
  );
  const preparedEntry = checkpointEntry(input.entries, "candidate-prepared");
  const candidateEntry = checkpointEntry(input.entries, "candidate-created");
  let candidateWorktreePath: string | undefined;
  let executorLaunchRecorded = false;
  const [processMetadataResource] = evidenceResources(
    input.entries,
    "process-metadata",
  );
  if (processMetadataResource) {
    const metadataPath = path.resolve(
      input.repositoryRoot,
      processMetadataResource.portableLocator,
    );
    const relative = path.relative(input.repositoryRoot, metadataPath);
    if (
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      (await exists(metadataPath))
    ) {
      try {
        executorLaunchRecorded =
          parseRecoveryProcessMetadata(
            JSON.parse(await readFile(metadataPath, "utf8")) as unknown,
            processMetadataResource,
          ).state === "launching";
      } catch {
        // The complete inspection below reports invalid metadata.
      }
    }
  }

  if (stagingEntry?.evidence.checkpoint === "staging-created") {
    const resource = stagingEntry.evidence.stagingResource;
    const container = durableExecutorStagingPath(
      input.executionRoot,
      input.executionId,
    );
    if (await exists(container)) {
      existingMutable.push(resource);
      try {
        const staging = await loadExecutorStagingRepository({
          containerPath: container,
          executionId: input.executionId,
          repositoryId: stagingEntry.identity.repositoryId,
          baseCommit: stagingEntry.baseCommit,
          expectedMarkerHash: stagingEntry.evidence.markerHash,
        });
        if (
          staging.durableIdentity?.markerHash !== resource.integrityHash ||
          staging.durableIdentity?.markerHash !==
            stagingEntry.evidence.markerHash
        )
          ambiguous.push("staging ownership hash does not match the journal");
        const source = await createSourceFingerprint(staging.repositoryPath);
        const executorFinished = checkpointEntry(
          input.entries,
          "executor-finished",
        );
        const patchCaptured = checkpointEntry(input.entries, "patch-captured");
        const expectedSource =
          patchCaptured?.evidence.checkpoint === "patch-captured"
            ? patchCaptured.evidence.stagingFingerprint
            : executorFinished?.evidence.checkpoint === "executor-finished"
              ? executorFinished.evidence.stagingFingerprint
              : stagingEntry.identity.sourceFingerprint;
        if (
          !(latest === "executor-started" && executorLaunchRecorded) &&
          source.hash !== expectedSource
        )
          ambiguous.push(
            "staging source fingerprint does not match checkpoint evidence",
          );
      } catch (error) {
        ambiguous.push(
          error instanceof Error
            ? error.message
            : "staging ownership is invalid",
        );
      }
    } else if (
      ["staging-created", "executor-started", "executor-finished"].includes(
        latest ?? "",
      )
    ) {
      ambiguous.push("required executor staging repository is missing");
    }

    const worktreeResource = stagingEntry.evidence.candidateWorktreeResource;
    const refResource = stagingEntry.evidence.candidateRefResource;
    try {
      const locator = await input.manager.load(input.executionId);
      if (!locator.discardedAt) {
        candidateWorktreePath = locator.worktreePath;
        existingMutable.push(worktreeResource);
      }
      if (
        !locator.repositoryId ||
        locator.repositoryId !== stagingEntry.identity.repositoryId ||
        locator.ownershipHash !== worktreeResource.integrityHash ||
        locator.worktreeGitDirectoryId !==
          worktreeResource.gitIdentity?.worktreeId
      )
        ambiguous.push(
          "candidate worktree ownership does not match the journal",
        );
    } catch (error) {
      if (!["discarded", "failed"].includes(latest ?? ""))
        ambiguous.push(
          error instanceof Error
            ? error.message
            : "candidate worktree is missing",
        );
    }

    const allowedRefCommits = new Set([stagingEntry.baseCommit]);
    if (preparedEntry?.evidence.checkpoint === "candidate-prepared")
      allowedRefCommits.add(preparedEntry.evidence.expectedCommit);
    if (candidateEntry?.evidence.checkpoint === "candidate-created") {
      allowedRefCommits.clear();
      allowedRefCommits.add(candidateEntry.evidence.commit);
    }
    const actualRef = await git(input.repositoryRoot, [
      "rev-parse",
      refResource.portableLocator,
    ]).catch(() => "");
    if (actualRef) {
      existingMutable.push(refResource);
      if (!allowedRefCommits.has(actualRef))
        conflicts.push("candidate ref points to an unexpected commit");
      const expectedCommitEvidence =
        candidateEntry?.evidence.checkpoint === "candidate-created"
          ? {
              parent: candidateEntry.evidence.parent,
              tree: candidateEntry.evidence.tree,
            }
          : preparedEntry?.evidence.checkpoint === "candidate-prepared" &&
              actualRef === preparedEntry.evidence.expectedCommit
            ? {
                parent: preparedEntry.evidence.parent,
                tree: preparedEntry.evidence.tree,
              }
            : undefined;
      if (expectedCommitEvidence) {
        const [parent, tree] = await Promise.all([
          git(input.repositoryRoot, ["rev-parse", `${actualRef}^`]).catch(
            () => "",
          ),
          git(input.repositoryRoot, ["rev-parse", `${actualRef}^{tree}`]).catch(
            () => "",
          ),
        ]);
        if (
          parent !== expectedCommitEvidence.parent ||
          tree !== expectedCommitEvidence.tree
        )
          conflicts.push("candidate commit tree or parent is inconsistent");
      }
    } else if (!["discarded", "failed"].includes(latest ?? "")) {
      ambiguous.push("candidate ref is missing");
    }

    if (
      patchEntry?.evidence.checkpoint === "patch-captured" &&
      candidateWorktreePath &&
      input.plan &&
      !candidateEntry &&
      actualRef === stagingEntry.baseCommit &&
      [
        "patch-captured",
        "scope-verified",
        "validation-passed",
        "architecture-passed",
        "candidate-prepared",
        "completed",
      ].includes(latest ?? "")
    ) {
      try {
        const candidateScope = await inspectMigrationScope({
          worktreeRoot: candidateWorktreePath,
          plan: input.plan,
        });
        const requiresMaterializedPatch = latest !== "patch-captured";
        if (
          (requiresMaterializedPatch ||
            candidateScope.changedFiles.length > 0) &&
          (!candidateScope.compliant ||
            candidateScope.patchHash !== patchEntry.evidence.patchHash ||
            recoveryHash(candidateScope.changedFiles) !==
              recoveryHash(patchEntry.evidence.changedFiles))
        )
          conflicts.push(
            "candidate worktree does not match the captured patch",
          );
      } catch {
        conflicts.push("candidate worktree patch could not be verified");
      }
    }
  }

  if (executorFinishedEntry?.evidence.checkpoint === "executor-finished") {
    const artifact = path.join(
      recoveryDirectory(input.repositoryRoot, input.executionId),
      "executor-result.json",
    );
    if (!(await exists(artifact)))
      ambiguous.push("durable executor result artifact is missing");
    else {
      try {
        assertExecutorResultMatchesFinishedEvidence(
          JSON.parse(await readFile(artifact, "utf8")) as unknown,
          executorFinishedEntry.evidence,
        );
      } catch {
        conflicts.push("durable executor result does not match the journal");
      }
    }
  }

  if (patchEntry?.evidence.checkpoint === "patch-captured") {
    const resource = patchEntry.evidence.patchResource;
    const absolute = path.resolve(
      input.repositoryRoot,
      resource.portableLocator,
    );
    const relative = path.relative(input.repositoryRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      ambiguous.push("patch resource escapes the repository");
    else {
      try {
        const patch = await readFile(absolute, "utf8");
        existingMutable.push(resource);
        if (
          recoveryHash(patch) !== resource.integrityHash ||
          hashNormalizedPatch(patch) !== patchEntry.evidence.patchHash
        )
          conflicts.push("captured patch identity does not match the journal");
      } catch {
        ambiguous.push("captured patch artifact is missing or unreadable");
      }
    }
  }

  for (const resource of [
    ...evidenceResources(input.entries, "candidate-index"),
  ]) {
    const absolute = path.resolve(
      input.repositoryRoot,
      resource.portableLocator,
    );
    const relative = path.relative(input.repositoryRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      ambiguous.push(`${resource.resourceType} locator escapes the repository`);
      continue;
    }
    if (!(await exists(absolute))) continue;
    existingMutable.push(resource);
    const marker = (await lstat(absolute)).isDirectory()
      ? path.join(absolute, "ownership.json")
      : absolute;
    try {
      const actual: unknown = JSON.parse(await readFile(marker, "utf8"));
      if (recoveryHash(actual) !== recoveryHash(resource))
        ambiguous.push(
          `${resource.resourceType} marker does not match ownership`,
        );
    } catch {
      ambiguous.push(`${resource.resourceType} marker is invalid`);
    }
  }

  let processMetadataObserved = false;
  for (const resource of evidenceResources(input.entries, "process-metadata")) {
    const absolute = path.resolve(
      input.repositoryRoot,
      resource.portableLocator,
    );
    const relative = path.relative(input.repositoryRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      ambiguous.push("process-metadata locator escapes the repository");
      continue;
    }
    if (!(await exists(absolute))) continue;
    processMetadataObserved = true;
    existingMutable.push(resource);
    try {
      const state = parseRecoveryProcessMetadata(
        JSON.parse(await readFile(absolute, "utf8")) as unknown,
        resource,
      ).state;
      if (latest === "executor-started" && state === "launching")
        processLaunchUncertain = true;
      else if (!(
        (latest === "staging-created" && state === "prepared") ||
        (latest === "executor-started" && state === "prepared") ||
        (latest === "executor-finished" && state === "launching")
      ))
        ambiguous.push(
          "process-metadata state does not match the latest checkpoint",
        );
    } catch {
      ambiguous.push("process-metadata marker is invalid");
    }
  }
  if (latest === "executor-started" && !processMetadataObserved)
    processLaunchUncertain = true;

  return {
    ambiguous,
    conflicts,
    existingMutable,
    processLaunchUncertain,
  };
};

const nextAction = (
  classification: MigrationRecoveryClassification,
  latest: MigrationRecoveryCheckpoint | null,
): string => {
  if (classification === "already-complete") return "No action required";
  if (classification === "manual-inspection-required")
    return "Inspect journal and resource ownership manually";
  if (classification === "cleanup-required")
    return "Run migrate cleanup with exact confirmation";
  if (classification === "unsafe-to-resume")
    return latest === "executor-started"
      ? "Do not relaunch the executor; clean up only when cleanupEligible is true"
      : "Do not resume this execution automatically";
  return `Resume after ${latest ?? "journal initialization"}`;
};

const decision = (input: {
  integrityValid: boolean;
  repositoryValid: boolean;
  approvalValid: boolean;
  resources: ResourceInspection;
  lock: ExecutionLockInspection;
  latest: MigrationRecoveryCheckpoint | null;
  completedValid: boolean;
}): MigrationRecoveryClassification => {
  if (
    !input.integrityValid ||
    !input.repositoryValid ||
    input.resources.ambiguous.length > 0 ||
    input.lock.status === "ambiguous"
  )
    return "manual-inspection-required";
  if (!input.approvalValid) return "unsafe-to-resume";
  if (input.resources.conflicts.length > 0) return "unsafe-to-resume";
  if (input.latest === "completed")
    return input.completedValid ? "already-complete" : "unsafe-to-resume";
  if (input.latest === "executor-started" || input.lock.status === "live")
    return "unsafe-to-resume";
  if (["failed", "discarded"].includes(input.latest ?? ""))
    return input.resources.existingMutable.length > 0
      ? "cleanup-required"
      : "unsafe-to-resume";
  return input.latest ? "resumable" : "manual-inspection-required";
};

export interface InspectMigrationRecoveryInput {
  repositoryRoot: string;
  executionId: string;
  executionRoot?: string;
  journalStore?: RecoveryJournalStore;
  executionStore?: ExecutionStore;
  worktreeManager?: WorktreeManager;
  ownedLockToken?: string;
}

export const inspectMigrationRecovery = async (
  input: InspectMigrationRecoveryInput,
): Promise<MigrationRecoveryReport> => {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const journalStore =
    input.journalStore ?? new JsonRecoveryJournalStore(repositoryRoot);
  const executionStore =
    input.executionStore ?? new JsonExecutionStore(repositoryRoot);
  const executionRoot =
    input.executionRoot ?? defaultExecutionRoot(repositoryRoot);
  const manager =
    input.worktreeManager ??
    new WorktreeManager({ repositoryRoot, executionRoot });
  const journal = await journalStore.loadJournal(input.executionId);
  const latest = latestRecoveryCheckpoint(journal.entries);
  const currentRepository =
    await captureRecoveryRepositoryIdentity(repositoryRoot);
  const first = journal.entries[0];
  let lock = await inspectExecutionLock({
    projectRoot: repositoryRoot,
    executionId: input.executionId,
    repositoryId:
      first?.identity.repositoryId ?? currentRepository.repositoryId,
  });
  if (
    input.ownedLockToken &&
    lock.owner?.token === input.ownedLockToken &&
    lock.owner.pid === process.pid
  )
    lock = { status: "unlocked" };
  let repositoryValid = Boolean(first);
  const approvalValid = Boolean(
    first && first.identity.approvalHash === recoveryHash(first.proposalId),
  );
  let integrity = journal.integrity;
  if (!first && integrity.valid)
    integrity = {
      valid: false,
      code: "journal-missing",
      message: "No Phase 4 recovery journal exists for this execution",
      temporaryFiles: integrity.temporaryFiles,
    };
  if (first)
    repositoryValid =
      first.identity.repositoryId === currentRepository.repositoryId &&
      first.identity.gitCommonDirectoryId ===
        currentRepository.gitCommonDirectoryId &&
      first.identity.originatingWorktreeId ===
        currentRepository.originatingWorktreeId;

  let planValid = false;
  let loadedPlan: MigrationExecutionPlan | undefined;
  let recordValid = false;
  let completedValid = false;
  if (first && integrity.valid) {
    try {
      const plan = await executionStore.loadPlan(input.executionId);
      loadedPlan = plan;
      planValid =
        plan.planId === first.planId &&
        plan.proposalId === first.proposalId &&
        plan.repository.baseCommit === first.baseCommit &&
        plan.repository.configHash === first.identity.configHash &&
        plan.repository.sourceFingerprint ===
          first.identity.sourceFingerprint &&
        recoveryHash(plan) === first.identity.planHash;
      const record = await executionStore.loadRecord(input.executionId);
      recordValid =
        record.executionId === first.executionId &&
        record.planId === first.planId &&
        record.proposalId === first.proposalId &&
        record.baseCommit === first.baseCommit;
      const completed = checkpointEntry(journal.entries, "completed");
      completedValid =
        completed?.evidence.checkpoint === "completed" &&
        record.status === "succeeded" &&
        recoveryHash(record) === completed.evidence.executionRecordHash &&
        record.fingerprints.mainAfter === record.fingerprints.mainBefore;
      if (latest !== "completed") {
        const ownedGitDirectory = await manager
          .gitDirectory(input.executionId)
          .catch(() => undefined);
        const main = await captureMainCheckoutState(repositoryRoot, {
          ownedCandidateRef: `refs/heads/${candidateBranchForExecution(input.executionId)}`,
          ...(ownedGitDirectory
            ? { ownedWorktreeGitDirectory: ownedGitDirectory }
            : {}),
        });
        if (main.fingerprint !== record.fingerprints.mainBefore)
          repositoryValid = false;
      }
    } catch {
      planValid = false;
    }
  }
  if (!planValid || !recordValid) repositoryValid = false;

  const resources = first
    ? await inspectResources({
        repositoryRoot,
        executionRoot,
        executionId: input.executionId,
        entries: journal.entries,
        ...(loadedPlan ? { plan: loadedPlan } : {}),
        manager,
      })
    : {
        ambiguous: [],
        conflicts: [],
        existingMutable: [],
        processLaunchUncertain: false,
      };
  const classification = decision({
    integrityValid: integrity.valid,
    repositoryValid,
    approvalValid,
    resources,
    lock,
    latest,
    completedValid,
  });
  const cleanupEligible =
    ["cleanup-required", "unsafe-to-resume"].includes(classification) &&
    resources.ambiguous.length === 0 &&
    resources.conflicts.length === 0 &&
    !resources.processLaunchUncertain &&
    !["live", "ambiguous"].includes(lock.status) &&
    resources.existingMutable.length > 0;
  const reportedIntegrity = !integrity.valid
    ? integrity
    : !repositoryValid
      ? {
          valid: false,
          code: "repository-identity-mismatch",
          message: "Repository, plan, record, or main identity does not match",
          temporaryFiles: integrity.temporaryFiles,
        }
      : resources.ambiguous.length > 0
        ? {
            valid: false,
            code: "resource-ownership-ambiguous",
            message: resources.ambiguous[0]!,
            temporaryFiles: integrity.temporaryFiles,
          }
        : resources.conflicts.length > 0
          ? {
              valid: false,
              code: "resource-integrity-mismatch",
              message: resources.conflicts[0]!,
              temporaryFiles: integrity.temporaryFiles,
            }
          : integrity;
  return migrationRecoveryReportSchema.parse({
    schemaVersion: "1.0.0",
    reportId: recoveryReportId({
      executionId: input.executionId,
      journalId: first?.journalId ?? null,
      latestCheckpoint: latest,
      latestSequence: journal.entries.at(-1)?.sequence ?? null,
      classification,
    }),
    executionId: input.executionId,
    classification,
    latestCheckpoint: latest,
    integrity: reportedIntegrity,
    nextSafeAction: nextAction(classification, latest),
    executorLaunchPermitted:
      classification === "resumable" &&
      ["planned", "preflight-passed", "staging-created"].includes(latest ?? ""),
    candidateCreationPermitted:
      classification === "resumable" && latest === "candidate-prepared",
    cleanupEligible,
    lock: { status: lock.status },
    resources: recoveryResources(journal.entries),
  });
};

export const listMigrationRecoveries = async (input: {
  repositoryRoot: string;
  executionRoot?: string;
}): Promise<MigrationRecoveryReport[]> => {
  const store = new JsonRecoveryJournalStore(
    path.resolve(input.repositoryRoot),
  );
  const reports = await Promise.all(
    (await store.listExecutionIds()).map((executionId) =>
      inspectMigrationRecovery({ ...input, executionId, journalStore: store }),
    ),
  );
  return reports
    .filter(({ classification }) => classification !== "already-complete")
    .sort((left, right) => left.executionId.localeCompare(right.executionId));
};

export const assertResumable = (report: MigrationRecoveryReport): void => {
  if (report.classification !== "resumable")
    throw new MigrationSafetyError(
      `Execution ${report.executionId} is ${report.classification}`,
      12,
      !report.integrity.valid &&
        ![
          "repository-identity-mismatch",
          "resource-ownership-ambiguous",
          "resource-integrity-mismatch",
        ].includes(report.integrity.code ?? "")
        ? "recovery-journal-integrity-failed"
        : "recovery-not-resumable",
    );
};
