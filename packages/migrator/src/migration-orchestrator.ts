import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { analyzeRepository } from "@braid/analyzer";
import {
  codexMigrationSummarySchema,
  configHash,
  createArchitectureSnapshot,
  migrationConfigHash,
  migrationExecutionRecordSchema,
  validationResultSchema,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type CodexMigrationSummary,
  type MigrationExecutionPlan,
  type MigrationExecutionRecord,
  type MigrationExecutionStatus,
  type MigrationProposal,
  type ScopeViolation,
  type ValidationResult,
} from "@braid/core";
import { MigrationSafetyError } from "@braid/shared";
import { JsonExecutionStore, type ExecutionStore } from "@braid/store";
import {
  assertExecutorDidNotCommit,
  createCandidateCommit,
} from "./candidate-commit.js";
import { createExecutionPlan } from "./execution-plan.js";
import { READINESS_REJECTION_EXIT_CODE } from "./execution-readiness.js";
import {
  createExecutorStagingRepository,
  type ExecutorStagingRepository,
} from "./executor-staging.js";
import type {
  ExecutorEnvironment,
  ExecutorEvent,
  ExecutorResult,
  MigrationExecutor,
} from "./executors/executor.js";
import { compareMigrationImpact } from "./impact-comparison.js";
import {
  assertMainCheckoutIntegrity,
  captureMainCheckoutState,
  type CaptureMainCheckoutStateOptions,
  type MainCheckoutState,
} from "./main-integrity.js";
import { runPreflight } from "./preflight.js";
import { buildMigrationPrompt } from "./prompt-builder.js";
import {
  captureSafetySurface,
  compareSafetySurfaces,
} from "./safety-surface.js";
import { inspectMigrationScope, type ScopeInspection } from "./scope-policy.js";
import { createSourceFingerprint } from "./source-fingerprint.js";
import { runValidationCommands } from "./validation-runner.js";
import {
  candidateBranchForExecution,
  defaultExecutionRoot,
  WorktreeManager,
} from "./worktree-manager.js";
import { redactSensitiveText } from "./safety.js";

export interface PrepareMigrationPlanInput {
  repositoryRoot: string;
  proposal: MigrationProposal;
  snapshot: ArchitectureSnapshot;
  config: ArchitectureConfig;
  executor: {
    kind: "codex" | "scripted-test";
    model?: string;
    reasoningEffort?: string;
    timeoutMs?: number;
  };
}

export interface RunMigrationInput extends PrepareMigrationPlanInput {
  approval?: string;
  migrationExecutor: MigrationExecutor;
  executionId?: string;
  createCommit?: boolean;
  executionStore?: ExecutionStore;
  worktreeManager?: WorktreeManager;
  now?: () => Date;
}

export interface MigrationRunResult {
  executionId: string;
  plan: MigrationExecutionPlan;
  record: MigrationExecutionRecord;
}

export const createExecutionId = (): string => `E-${randomUUID()}`;

const sorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const sanitizePortableText = (
  value: string,
  privatePaths: readonly string[],
): string =>
  redactSensitiveText(
    privatePaths
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

const safetyError = (
  error: unknown,
  exitCode: 7 | 8 | 9 | 10 | 11,
  code: string,
): MigrationSafetyError =>
  error instanceof MigrationSafetyError
    ? error
    : new MigrationSafetyError(
        error instanceof Error ? error.message : String(error),
        exitCode,
        code,
        error instanceof Error ? { cause: error } : undefined,
      );

const portableSnapshot = (snapshot: ArchitectureSnapshot): unknown => ({
  ...snapshot,
  projectRoot: ".",
  repository: { ...snapshot.repository, projectRoot: "." },
});

const sanitizeValidation = (
  results: readonly ValidationResult[],
  privatePaths: readonly string[],
): ValidationResult[] =>
  results.map((result) =>
    validationResultSchema.parse({
      ...result,
      stdout: sanitizePortableText(result.stdout, privatePaths),
      stderr: sanitizePortableText(result.stderr, privatePaths),
    }),
  );

const sanitizeEvents = (
  events: readonly ExecutorEvent[],
  privatePaths: readonly string[],
): ExecutorEvent[] =>
  events.map((event) => ({
    ...event,
    ...(event.command
      ? {
          command: event.command.map((part) =>
            sanitizePortableText(part, privatePaths),
          ),
        }
      : {}),
    ...(event.message
      ? { message: sanitizePortableText(event.message, privatePaths) }
      : {}),
  }));

const sanitizeSummary = (
  summary: CodexMigrationSummary,
  privatePaths: readonly string[],
): CodexMigrationSummary =>
  codexMigrationSummarySchema.parse({
    ...summary,
    testsRun: summary.testsRun.map((item) =>
      sanitizePortableText(item, privatePaths),
    ),
    summary: sanitizePortableText(summary.summary, privatePaths),
    unresolvedConcerns: summary.unresolvedConcerns.map((item) =>
      sanitizePortableText(item, privatePaths),
    ),
  });

const usageFrom = (
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
  const { patch, ...scope } = inspection;
  void patch;
  return scope;
};

const mergeSurfaceViolations = (
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

const candidateFingerprint = async (
  worktreePath: string,
  patchHash: string,
): Promise<string> => {
  const source = await createSourceFingerprint(worktreePath);
  return createHash("sha256")
    .update(JSON.stringify([source.hash, patchHash]))
    .digest("hex");
};

const planExecutorConfiguration = (input: PrepareMigrationPlanInput) => {
  const configuredModel =
    input.executor.kind === "codex" ? input.config.migration.codex.model : null;
  const configuredReasoning =
    input.executor.kind === "codex"
      ? input.config.migration.codex.reasoningEffort
      : null;
  return {
    kind: input.executor.kind,
    ...((input.executor.model ?? configuredModel)
      ? { model: input.executor.model ?? configuredModel! }
      : {}),
    ...((input.executor.reasoningEffort ?? configuredReasoning)
      ? {
          reasoningEffort:
            input.executor.reasoningEffort ?? configuredReasoning!,
        }
      : {}),
    ...(input.executor.timeoutMs === undefined
      ? {}
      : { timeoutMs: input.executor.timeoutMs }),
  };
};

export const prepareMigrationPlan = async (
  input: PrepareMigrationPlanInput,
): Promise<MigrationExecutionPlan> => {
  const preflight = await runPreflight({
    repositoryRoot: input.repositoryRoot,
    proposal: input.proposal,
    snapshot: input.snapshot,
    config: input.config,
    requireApproval: false,
  });
  return createExecutionPlan({
    proposal: input.proposal,
    snapshot: input.snapshot,
    config: input.config,
    baseCommit: preflight.baseCommit,
    sourceFingerprint: preflight.sourceFingerprint,
    executor: planExecutorConfiguration(input),
  });
};

export const runMigration = async (
  input: RunMigrationInput,
): Promise<MigrationRunResult> => {
  if (input.migrationExecutor.kind !== input.executor.kind)
    throw new MigrationSafetyError(
      "Executor implementation does not match the deterministic plan",
      7,
      "executor-kind-mismatch",
    );
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const executionId = input.executionId ?? createExecutionId();
  const now = input.now ?? (() => new Date());
  const store = input.executionStore ?? new JsonExecutionStore(repositoryRoot);
  let plan: MigrationExecutionPlan;
  try {
    plan = await prepareMigrationPlan({ ...input, repositoryRoot });
  } catch (error) {
    if (input.proposal.type === "extract-module") {
      try {
        const main = await captureMainCheckoutState(repositoryRoot);
        const rejectedPlan = createExecutionPlan({
          proposal: input.proposal,
          snapshot: input.snapshot,
          config: input.config,
          baseCommit: input.snapshot.gitCommit ?? main.head,
          sourceFingerprint:
            input.snapshot.sourceFingerprint ?? main.sourceFingerprint,
          executor: planExecutorConfiguration(input),
        });
        const rejectedError =
          error instanceof MigrationSafetyError
            ? error
            : new MigrationSafetyError(
                error instanceof Error ? error.message : String(error),
                5,
                "preflight-failed",
              );
        const rejectedPlanned = migrationExecutionRecordSchema.parse({
          schemaVersion: 1,
          executionId,
          planId: rejectedPlan.planId,
          proposalId: rejectedPlan.proposalId,
          status: "planned",
          startedAt: now().toISOString(),
          baseCommit: rejectedPlan.repository.baseCommit,
          executor: {
            kind: rejectedPlan.executor.kind,
            ...(rejectedPlan.executor.requestedModel
              ? { model: rejectedPlan.executor.requestedModel }
              : {}),
            ...(rejectedPlan.executor.requestedReasoningEffort
              ? {
                  reasoningEffort:
                    rejectedPlan.executor.requestedReasoningEffort,
                }
              : {}),
            sandbox: "workspace-write",
          },
          scope: {
            allowedFiles: sorted([
              ...rejectedPlan.scope.allowedExistingFiles,
              ...rejectedPlan.scope.allowedTestFiles,
              ...rejectedPlan.scope.allowedNewFilePatterns,
            ]),
            changedFiles: [],
            addedFiles: [],
            deletedFiles: [],
            violations: [],
          },
          validation: [],
          architecture: {
            beforeSnapshotId: input.snapshot.id,
            predictedImpact: rejectedPlan.expectedChange.predictedImpact,
          },
          fingerprints: {
            mainBefore: main.fingerprint,
            candidateBefore: rejectedPlan.repository.sourceFingerprint,
          },
          artifacts: {},
        });
        const rejectedRecord = migrationExecutionRecordSchema.parse({
          ...rejectedPlanned,
          status: "preflight-failed",
          completedAt: now().toISOString(),
          fingerprints: {
            ...rejectedPlanned.fingerprints,
            mainAfter: main.fingerprint,
          },
          failure: {
            stage: "preflight",
            code: rejectedError.code,
            message: sanitizePortableText(rejectedError.message, [
              repositoryRoot,
              homedir(),
            ]),
          },
        });
        await store.savePlan(executionId, rejectedPlan);
        await store.saveRecord(rejectedPlanned);
        await store.saveRecord(rejectedRecord);
      } catch {
        // Preserve the original safety rejection when it cannot be recorded.
      }
    }
    throw error;
  }
  const expectedCandidateBranch = candidateBranchForExecution(executionId);
  let mainIntegrityOptions: CaptureMainCheckoutStateOptions = {
    ownedCandidateRef: `refs/heads/${expectedCandidateBranch}`,
  };
  const mainBefore = await captureMainCheckoutState(
    repositoryRoot,
    mainIntegrityOptions,
  );
  const startedAt = now().toISOString();
  let record = migrationExecutionRecordSchema.parse({
    schemaVersion: 1,
    executionId,
    planId: plan.planId,
    proposalId: plan.proposalId,
    status: "planned",
    startedAt,
    baseCommit: plan.repository.baseCommit,
    executor: {
      kind: plan.executor.kind,
      ...(plan.executor.requestedModel
        ? { model: plan.executor.requestedModel }
        : {}),
      ...(plan.executor.requestedReasoningEffort
        ? { reasoningEffort: plan.executor.requestedReasoningEffort }
        : {}),
      sandbox: "workspace-write",
    },
    scope: {
      allowedFiles: sorted([
        ...plan.scope.allowedExistingFiles,
        ...plan.scope.allowedTestFiles,
        ...plan.scope.allowedNewFilePatterns,
      ]),
      changedFiles: [],
      addedFiles: [],
      deletedFiles: [],
      violations: [],
    },
    validation: [],
    architecture: {
      beforeSnapshotId: input.snapshot.id,
      predictedImpact: plan.expectedChange.predictedImpact,
    },
    fingerprints: {
      mainBefore: mainBefore.fingerprint,
      candidateBefore: plan.repository.sourceFingerprint,
    },
    artifacts: {},
  });
  await store.savePlan(executionId, plan);
  await store.saveRecord(record);

  const transition = async (
    next: MigrationExecutionRecord,
  ): Promise<MigrationExecutionRecord> => {
    record = migrationExecutionRecordSchema.parse(next);
    await store.saveRecord(record);
    return record;
  };

  const terminalFailure = async (
    errorInput: unknown,
    defaultExitCode: 7 | 8 | 9 | 10 | 11,
    defaultCode: string,
    requestedStatus: MigrationExecutionStatus,
    worktreePath?: string,
  ): Promise<never> => {
    let error = safetyError(errorInput, defaultExitCode, defaultCode);
    let mainAfter: MainCheckoutState;
    try {
      mainAfter = await captureMainCheckoutState(
        repositoryRoot,
        mainIntegrityOptions,
      );
      assertMainCheckoutIntegrity(mainBefore, mainAfter);
    } catch (integrityError) {
      error = safetyError(integrityError, 11, "main-checkout-mutated");
      mainAfter = await captureMainCheckoutState(
        repositoryRoot,
        mainIntegrityOptions,
      );
    }
    const privatePaths = [repositoryRoot, homedir()];
    if (worktreePath) {
      privatePaths.push(worktreePath);
      try {
        privatePaths.push(await realpath(worktreePath));
      } catch {
        // A failed worktree may already be unavailable.
      }
    }
    const status =
      error.exitCode === 11
        ? record.status === "planned"
          ? "preflight-failed"
          : "executor-failed"
        : requestedStatus;
    await transition(
      migrationExecutionRecordSchema.parse({
        ...record,
        status,
        completedAt: now().toISOString(),
        fingerprints: {
          ...record.fingerprints,
          mainAfter: mainAfter.fingerprint,
        },
        failure: {
          stage:
            error.exitCode === 8
              ? "scope"
              : error.exitCode === 9
                ? "validation"
                : error.exitCode === 10
                  ? "architecture"
                  : error.exitCode === 11
                    ? "main-integrity"
                    : "executor",
          code: error.code,
          message: sanitizePortableText(error.message, privatePaths),
        },
      }),
    );
    throw error;
  };

  try {
    await runPreflight({
      repositoryRoot,
      proposal: input.proposal,
      snapshot: input.snapshot,
      config: input.config,
      ...(input.approval === undefined ? {} : { approval: input.approval }),
      requireApproval: true,
    });
  } catch (error) {
    const preflightError =
      error instanceof MigrationSafetyError
        ? error
        : new MigrationSafetyError(
            error instanceof Error ? error.message : String(error),
            5,
            "preflight-failed",
          );
    const mainAfter = await captureMainCheckoutState(
      repositoryRoot,
      mainIntegrityOptions,
    );
    let finalError = preflightError;
    try {
      assertMainCheckoutIntegrity(mainBefore, mainAfter);
    } catch (integrityError) {
      finalError = safetyError(integrityError, 11, "main-checkout-mutated");
    }
    await transition(
      migrationExecutionRecordSchema.parse({
        ...record,
        status: "preflight-failed",
        completedAt: now().toISOString(),
        fingerprints: {
          ...record.fingerprints,
          mainAfter: mainAfter.fingerprint,
        },
        failure: {
          stage: finalError.exitCode === 11 ? "main-integrity" : "preflight",
          code: finalError.code,
          message: sanitizePortableText(finalError.message, [
            repositoryRoot,
            homedir(),
          ]),
        },
      }),
    );
    throw finalError;
  }

  if (plan.readiness?.state === "not-ready") {
    const readinessError = new MigrationSafetyError(
      `Migration proposal is not execution-ready: ${plan.readiness.blockingReasons
        .map(({ code, message }) => `${code}: ${message}`)
        .join("; ")}`,
      READINESS_REJECTION_EXIT_CODE,
      "execution-not-ready",
    );
    const mainAfter = await captureMainCheckoutState(
      repositoryRoot,
      mainIntegrityOptions,
    );
    let finalError = readinessError;
    try {
      assertMainCheckoutIntegrity(mainBefore, mainAfter);
    } catch (integrityError) {
      finalError = safetyError(integrityError, 11, "main-checkout-mutated");
    }
    await transition(
      migrationExecutionRecordSchema.parse({
        ...record,
        status: "preflight-failed",
        completedAt: now().toISOString(),
        fingerprints: {
          ...record.fingerprints,
          mainAfter: mainAfter.fingerprint,
        },
        failure: {
          stage: finalError.exitCode === 11 ? "main-integrity" : "readiness",
          code: finalError.code,
          message: sanitizePortableText(finalError.message, [
            repositoryRoot,
            homedir(),
          ]),
        },
      }),
    );
    throw finalError;
  }

  const manager =
    input.worktreeManager ??
    new WorktreeManager({
      repositoryRoot,
      executionRoot: defaultExecutionRoot(repositoryRoot),
    });
  let owned;
  try {
    owned = await manager.create(executionId, plan.repository.baseCommit, {
      proposalId: plan.proposalId,
      planId: plan.planId,
    });
  } catch (error) {
    return terminalFailure(
      error,
      7,
      "worktree-create-failed",
      "preflight-failed",
    );
  }
  const worktreePath = owned.worktreePath;
  const privatePaths = [repositoryRoot, worktreePath, homedir()];
  try {
    privatePaths.push(await realpath(worktreePath));
  } catch {
    // The manager already verified the path; realpath only improves redaction.
  }
  record = await transition(
    migrationExecutionRecordSchema.parse({
      ...record,
      status: "worktree-created",
      candidateBranch: owned.branch,
    }),
  );
  try {
    mainIntegrityOptions = {
      ...mainIntegrityOptions,
      ownedWorktreeGitDirectory: await manager.gitDirectory(executionId),
    };
    await manager.assertOwnedState(executionId, plan.repository.baseCommit);
    const afterWorktreeCreation = await captureMainCheckoutState(
      repositoryRoot,
      mainIntegrityOptions,
    );
    assertMainCheckoutIntegrity(mainBefore, afterWorktreeCreation);
  } catch (error) {
    return terminalFailure(
      error,
      11,
      "worktree-integrity-failed",
      "executor-failed",
      worktreePath,
    );
  }
  let candidateBefore;
  try {
    candidateBefore = await createSourceFingerprint(worktreePath);
  } catch (error) {
    return terminalFailure(
      error,
      7,
      "candidate-fingerprint-failed",
      "executor-failed",
      worktreePath,
    );
  }
  if (candidateBefore.hash !== plan.repository.sourceFingerprint)
    return terminalFailure(
      new MigrationSafetyError(
        "Candidate worktree does not match the approved source fingerprint",
        6,
        "candidate-base-fingerprint-mismatch",
      ),
      7,
      "candidate-base-fingerprint-mismatch",
      "executor-failed",
      worktreePath,
    );

  let environment: ExecutorEnvironment;
  try {
    environment = await input.migrationExecutor.inspect();
  } catch (error) {
    return terminalFailure(
      error,
      7,
      "executor-inspection-failed",
      "executor-failed",
      worktreePath,
    );
  }
  record = await transition(
    migrationExecutionRecordSchema.parse({
      ...record,
      status: "running",
      executor: {
        ...record.executor,
        ...(environment.executableVersion
          ? { executableVersion: environment.executableVersion }
          : {}),
        sandbox: environment.sandbox,
      },
    }),
  );

  const assertCandidateOwnershipAtBase = async (): Promise<void> => {
    await assertExecutorDidNotCommit(worktreePath, plan.repository.baseCommit);
    await manager.assertOwnedState(executionId, plan.repository.baseCommit);
  };

  let executorStaging: ExecutorStagingRepository;
  try {
    executorStaging = await createExecutorStagingRepository(
      repositoryRoot,
      plan.repository.baseCommit,
    );
    const stagedSource = await createSourceFingerprint(
      executorStaging.repositoryPath,
    );
    if (stagedSource.hash !== plan.repository.sourceFingerprint)
      throw new MigrationSafetyError(
        "Executor staging repository does not match the approved source fingerprint",
        7,
        "executor-staging-fingerprint-mismatch",
      );
  } catch (error) {
    return terminalFailure(
      error,
      7,
      "executor-staging-failed",
      "executor-failed",
      worktreePath,
    );
  }
  privatePaths.push(executorStaging.repositoryPath);
  let stagingDisposed = false;
  const disposeExecutorStaging = async (): Promise<void> => {
    if (stagingDisposed) return;
    await executorStaging.dispose();
    stagingDisposed = true;
  };
  const assertExecutorBoundary = async (): Promise<void> => {
    await executorStaging.assertGitState();
    await assertCandidateOwnershipAtBase();
  };

  let executorResult: ExecutorResult;
  try {
    executorResult = await input.migrationExecutor.execute(plan, {
      worktreePath: executorStaging.repositoryPath,
      prompt: buildMigrationPrompt(plan),
      timeoutMs: plan.executor.timeoutMs,
    });
  } catch (error) {
    try {
      await assertExecutorBoundary();
    } catch (commitError) {
      await disposeExecutorStaging().catch(() => undefined);
      return terminalFailure(
        commitError,
        8,
        "executor-created-commit",
        "scope-violation",
        worktreePath,
      );
    }
    try {
      await disposeExecutorStaging();
    } catch (cleanupError) {
      return terminalFailure(
        cleanupError,
        7,
        "executor-staging-cleanup-failed",
        "executor-failed",
        worktreePath,
      );
    }
    return terminalFailure(
      error,
      7,
      "executor-threw",
      "executor-failed",
      worktreePath,
    );
  }

  const events = sanitizeEvents(executorResult.events, privatePaths);
  const summary = executorResult.summary
    ? sanitizeSummary(executorResult.summary, privatePaths)
    : undefined;
  const eventLog = await store.writeTextArtifact(
    executionId,
    "codex-events.jsonl",
    events.length > 0
      ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
      : "",
  );
  await store.writeTextArtifact(
    executionId,
    "codex-stderr.log",
    sanitizePortableText(executorResult.stderr, privatePaths),
  );
  const finalSummary = summary
    ? await store.writeJsonArtifact(executionId, "codex-summary.json", summary)
    : undefined;
  record = migrationExecutionRecordSchema.parse({
    ...record,
    executor: {
      ...record.executor,
      ...(executorResult.exitCode === null
        ? {}
        : { exitCode: executorResult.exitCode }),
      timedOut: executorResult.timedOut,
      ...(usageFrom(events) ? { usage: usageFrom(events) } : {}),
    },
    artifacts: {
      ...record.artifacts,
      eventLog,
      ...(finalSummary ? { finalSummary } : {}),
    },
  });

  try {
    await assertExecutorBoundary();
  } catch (error) {
    await disposeExecutorStaging().catch(() => undefined);
    return terminalFailure(
      error,
      8,
      "executor-created-commit",
      "scope-violation",
      worktreePath,
    );
  }

  const persistScopeArtifacts = async (
    inspection: ScopeInspection,
  ): Promise<void> => {
    await store.writeJsonArtifact(
      executionId,
      "scope.json",
      withoutPatch(inspection),
    );
    const patch =
      inspection.compliant && inspection.patch
        ? await store.writeTextArtifact(
            executionId,
            "candidate.patch",
            inspection.patch,
          )
        : undefined;
    record = migrationExecutionRecordSchema.parse({
      ...record,
      scope: {
        ...record.scope,
        changedFiles: inspection.changedFiles,
        addedFiles: inspection.addedFiles,
        deletedFiles: inspection.deletedFiles,
        violations: inspection.violations,
      },
      fingerprints: {
        ...record.fingerprints,
        diffHash: inspection.patchHash,
      },
      artifacts: {
        ...record.artifacts,
        ...(patch ? { patch } : {}),
      },
    });
  };

  let scope: ScopeInspection;
  try {
    scope = await inspectMigrationScope({
      worktreeRoot: executorStaging.repositoryPath,
      plan,
      publicEntrypoints: input.snapshot.repository.publicEntrypoints,
    });
  } catch (error) {
    await disposeExecutorStaging().catch(() => undefined);
    return terminalFailure(
      error,
      8,
      "scope-inspection-failed",
      "scope-violation",
      worktreePath,
    );
  }
  if (
    executorResult.timedOut ||
    executorResult.exitCode !== 0 ||
    (plan.executor.kind === "codex" && !summary)
  ) {
    await persistScopeArtifacts(scope);
    try {
      await disposeExecutorStaging();
    } catch (error) {
      return terminalFailure(
        error,
        7,
        "executor-staging-cleanup-failed",
        "executor-failed",
        worktreePath,
      );
    }
    return terminalFailure(
      new MigrationSafetyError(
        executorResult.timedOut
          ? "Migration executor timed out"
          : executorResult.exitCode !== 0
            ? `Migration executor exited with code ${executorResult.exitCode}`
            : "Codex did not return a valid structured summary",
        7,
        executorResult.timedOut
          ? "executor-timeout"
          : executorResult.exitCode !== 0
            ? "executor-nonzero-exit"
            : "executor-summary-invalid",
      ),
      7,
      "executor-failed",
      "executor-failed",
      worktreePath,
    );
  }
  if (scope.changedFiles.length === 0) {
    await persistScopeArtifacts(scope);
    try {
      await disposeExecutorStaging();
    } catch (error) {
      return terminalFailure(
        error,
        7,
        "executor-staging-cleanup-failed",
        "executor-failed",
        worktreePath,
      );
    }
    return terminalFailure(
      new MigrationSafetyError(
        "Migration executor made no source changes",
        8,
        "no-changes",
      ),
      8,
      "no-changes",
      "no-changes",
      worktreePath,
    );
  }
  if (!scope.compliant) {
    await persistScopeArtifacts(scope);
    try {
      await disposeExecutorStaging();
    } catch (error) {
      return terminalFailure(
        error,
        7,
        "executor-staging-cleanup-failed",
        "executor-failed",
        worktreePath,
      );
    }
    return terminalFailure(
      new MigrationSafetyError(
        "Migration diff violates the approved scope",
        8,
        "scope-violation",
      ),
      8,
      "scope-violation",
      "scope-violation",
      worktreePath,
    );
  }

  const stagedScope = scope;
  try {
    await executorStaging.materialize(worktreePath, stagedScope.changedFiles);
    await disposeExecutorStaging();
    await assertCandidateOwnershipAtBase();
    scope = await inspectMigrationScope({
      worktreeRoot: worktreePath,
      plan,
      publicEntrypoints: input.snapshot.repository.publicEntrypoints,
    });
    if (
      !scope.compliant ||
      scope.patchHash !== stagedScope.patchHash ||
      JSON.stringify(scope.changedFiles) !==
        JSON.stringify(stagedScope.changedFiles)
    )
      throw new MigrationSafetyError(
        "Materialized candidate does not match the inspected executor output",
        8,
        "executor-staging-materialization-mismatch",
      );
  } catch (error) {
    await disposeExecutorStaging().catch(() => undefined);
    await persistScopeArtifacts(stagedScope);
    return terminalFailure(
      error,
      8,
      "executor-staging-materialization-failed",
      "scope-violation",
      worktreePath,
    );
  }

  let validation;
  try {
    validation = await runValidationCommands({
      worktreeRoot: worktreePath,
      commands: plan.validation.commands,
    });
  } catch (error) {
    await persistScopeArtifacts(scope);
    return terminalFailure(
      error,
      9,
      "validation-runner-failed",
      "validation-failed",
      worktreePath,
    );
  }
  const validationResults = sanitizeValidation(
    validation.results,
    privatePaths,
  );
  const validationReport = await store.writeJsonArtifact(
    executionId,
    "validation.json",
    { passed: validation.passed, results: validationResults },
  );
  record = migrationExecutionRecordSchema.parse({
    ...record,
    validation: validationResults,
    artifacts: { ...record.artifacts, validationReport },
  });
  try {
    await assertCandidateOwnershipAtBase();
  } catch (error) {
    await persistScopeArtifacts(scope);
    return terminalFailure(
      error,
      8,
      "validation-created-commit",
      "scope-violation",
      worktreePath,
    );
  }
  try {
    scope = await inspectMigrationScope({
      worktreeRoot: worktreePath,
      plan,
      publicEntrypoints: input.snapshot.repository.publicEntrypoints,
    });
  } catch (error) {
    return terminalFailure(
      error,
      8,
      "post-validation-scope-inspection-failed",
      "scope-violation",
      worktreePath,
    );
  }
  record = migrationExecutionRecordSchema.parse({
    ...record,
    validation: validationResults,
    scope: {
      ...record.scope,
      changedFiles: scope.changedFiles,
      addedFiles: scope.addedFiles,
      deletedFiles: scope.deletedFiles,
      violations: scope.violations,
    },
    fingerprints: { ...record.fingerprints, diffHash: scope.patchHash },
    artifacts: { ...record.artifacts, validationReport },
  });
  if (!validation.passed) {
    await persistScopeArtifacts(scope);
    return terminalFailure(
      new MigrationSafetyError(
        "A required migration validation command failed",
        9,
        "required-validation-failed",
      ),
      9,
      "required-validation-failed",
      "validation-failed",
      worktreePath,
    );
  }
  if (!scope.compliant) {
    await persistScopeArtifacts(scope);
    return terminalFailure(
      new MigrationSafetyError(
        "Validation changed files outside the approved scope",
        8,
        "post-validation-scope-violation",
      ),
      8,
      "post-validation-scope-violation",
      "scope-violation",
      worktreePath,
    );
  }

  let afterSnapshot: ArchitectureSnapshot;
  try {
    const afterAnalysis = await analyzeRepository(worktreePath, input.config);
    const afterFingerprint = await candidateFingerprint(
      worktreePath,
      scope.patchHash,
    );
    afterSnapshot = createArchitectureSnapshot({
      projectRoot: worktreePath,
      gitCommit: plan.repository.baseCommit,
      configHash: configHash(input.config),
      migrationConfigHash: migrationConfigHash(input.config),
      sourceFingerprint: afterFingerprint,
      repository: afterAnalysis.repository,
      metrics: afterAnalysis.metrics,
      createdAt: now(),
    });
  } catch (error) {
    return terminalFailure(
      error,
      10,
      "candidate-analysis-failed",
      "needs-review",
      worktreePath,
    );
  }
  const publicEntrypoints = sorted([
    ...input.snapshot.repository.publicEntrypoints,
    ...afterSnapshot.repository.publicEntrypoints,
  ]);
  try {
    scope = await inspectMigrationScope({
      worktreeRoot: worktreePath,
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
        repositoryRoot: worktreePath,
        publicEntrypoints,
        snapshot: afterSnapshot,
      }),
    ]);
    scope = mergeSurfaceViolations(
      scope,
      compareSafetySurfaces(surfaceBefore, surfaceAfter),
    );
  } catch (error) {
    return terminalFailure(
      error,
      8,
      "safety-surface-inspection-failed",
      "scope-violation",
      worktreePath,
    );
  }
  await persistScopeArtifacts(scope);
  record = migrationExecutionRecordSchema.parse({
    ...record,
    fingerprints: {
      ...record.fingerprints,
      candidateAfter: afterSnapshot.sourceFingerprint,
    },
  });
  if (!scope.compliant)
    return terminalFailure(
      new MigrationSafetyError(
        "Dependency, configuration, or public API safety surface changed",
        8,
        "safety-surface-violation",
      ),
      8,
      "safety-surface-violation",
      "scope-violation",
      worktreePath,
    );

  const architecture = compareMigrationImpact({
    plan,
    before: input.snapshot,
    after: afterSnapshot,
    changedFiles: scope.changedFiles,
    protectedPaths: input.config.protected_paths,
  });
  await Promise.all([
    store.writeJsonArtifact(
      executionId,
      "architecture-before.json",
      portableSnapshot(input.snapshot),
    ),
    store.writeJsonArtifact(
      executionId,
      "architecture-after.json",
      portableSnapshot(afterSnapshot),
    ),
    store.writeJsonArtifact(
      executionId,
      "impact-comparison.json",
      architecture,
    ),
  ]);
  record = migrationExecutionRecordSchema.parse({
    ...record,
    architecture: {
      ...record.architecture,
      afterSnapshotId: afterSnapshot.id,
      actualImpact: architecture.impact,
      comparison: architecture.comparison,
    },
  });
  if (!architecture.passed)
    return terminalFailure(
      new MigrationSafetyError(
        `Architecture validation failed: ${architecture.failures.join(", ")}`,
        10,
        "architecture-validation-failed",
      ),
      10,
      "architecture-validation-failed",
      "needs-review",
      worktreePath,
    );

  const validatedPatchHash = scope.patchHash;
  const validatedChangedFiles = JSON.stringify(scope.changedFiles);
  try {
    await assertCandidateOwnershipAtBase();
    const finalScope = await inspectMigrationScope({
      worktreeRoot: worktreePath,
      plan,
      publicEntrypoints,
    });
    const finalFingerprint = await candidateFingerprint(
      worktreePath,
      finalScope.patchHash,
    );
    if (
      !finalScope.compliant ||
      finalScope.patchHash !== validatedPatchHash ||
      JSON.stringify(finalScope.changedFiles) !== validatedChangedFiles ||
      finalFingerprint !== afterSnapshot.sourceFingerprint
    )
      throw new MigrationSafetyError(
        "Candidate changed after scope, validation, or architecture checks",
        8,
        "candidate-changed-after-validation",
      );
    scope = finalScope;
  } catch (error) {
    return terminalFailure(
      error,
      8,
      "candidate-changed-after-validation",
      "scope-violation",
      worktreePath,
    );
  }

  const beforeCommitMain = await captureMainCheckoutState(
    repositoryRoot,
    mainIntegrityOptions,
  );
  try {
    assertMainCheckoutIntegrity(mainBefore, beforeCommitMain);
  } catch (error) {
    return terminalFailure(
      error,
      11,
      "main-checkout-mutated",
      "executor-failed",
      worktreePath,
    );
  }
  let commit: string | undefined;
  if (input.createCommit !== false) {
    try {
      commit = await createCandidateCommit({
        worktreePath,
        baseCommit: plan.repository.baseCommit,
        candidateBranch: owned.branch,
        proposalId: plan.proposalId,
        executionId,
        planId: plan.planId,
        changedFiles: scope.changedFiles,
        expectedPatchHash: scope.patchHash,
      });
      record = migrationExecutionRecordSchema.parse({
        ...record,
        candidateCommit: commit,
      });
      await manager.recordCandidateCommit(executionId, commit);
      await manager.assertOwnedState(executionId, commit);
    } catch (error) {
      return terminalFailure(
        error,
        8,
        "candidate-commit-failed",
        "scope-violation",
        worktreePath,
      );
    }
  }
  try {
    await manager.assertOwnedState(
      executionId,
      commit ?? plan.repository.baseCommit,
    );
  } catch (error) {
    return terminalFailure(
      error,
      8,
      "owned-worktree-state-changed",
      "scope-violation",
      worktreePath,
    );
  }
  const mainAfter = await captureMainCheckoutState(
    repositoryRoot,
    mainIntegrityOptions,
  );
  try {
    assertMainCheckoutIntegrity(mainBefore, mainAfter);
  } catch (error) {
    return terminalFailure(
      error,
      11,
      "main-checkout-mutated",
      "executor-failed",
      worktreePath,
    );
  }
  try {
    await manager.assertOwnedState(
      executionId,
      commit ?? plan.repository.baseCommit,
    );
  } catch (error) {
    return terminalFailure(
      error,
      8,
      "owned-worktree-state-changed",
      "scope-violation",
      worktreePath,
    );
  }
  record = await transition(
    migrationExecutionRecordSchema.parse({
      ...record,
      status: "succeeded",
      completedAt: now().toISOString(),
      ...(commit ? { candidateCommit: commit } : {}),
      fingerprints: {
        ...record.fingerprints,
        mainAfter: mainAfter.fingerprint,
      },
    }),
  );
  return { executionId, plan, record };
};
