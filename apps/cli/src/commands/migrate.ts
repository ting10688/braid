import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  loadArchitectureConfig,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type MigrationProposal,
  type ProposalRepairSuggestion,
} from "@braid/core";
import {
  CodexExecutor,
  WorktreeManager,
  assertMainCheckoutIntegrity,
  candidateBranchForExecution,
  captureMainCheckoutState,
  createExecutionId,
  defaultExecutionRoot,
  prepareMigrationPlan,
  runMigration,
  suggestProposalRepair,
  type MigrationExecutor,
} from "@braid/migrator";
import {
  CONFIG_FILE,
  EXECUTIONS_DIRECTORY,
  InvalidInputError,
  MigrationSafetyError,
  PersistenceError,
} from "@braid/shared";
import {
  JsonExecutionStore,
  JsonProposalStore,
  JsonSnapshotStore,
} from "@braid/store";

interface ProjectOptions {
  path?: string;
  json?: boolean;
}

export type MigratePlanOptions = ProjectOptions;

export type MigrateSuggestOptions = ProjectOptions;

export interface MigrateRunOptions extends ProjectOptions {
  approve?: string;
  executor?: string;
  model?: string;
  reasoningEffort?: string;
  timeout?: string | number;
  commit?: boolean;
}

export interface MigrateDiscardOptions extends ProjectOptions {
  confirm?: string;
}

export interface MigrateRunDependencies {
  executorFactory?: (config: ArchitectureConfig) => MigrationExecutor;
  executionIdFactory?: () => string;
}

const projectRoot = (options: ProjectOptions): string =>
  path.resolve(options.path ?? ".");

const loadContext = async (root: string, proposalId: string) => {
  if (!/^P-(?:EM|BC)-[a-f0-9]{8}$/u.test(proposalId))
    throw new InvalidInputError(`Invalid migration proposal ID: ${proposalId}`);
  const config = await loadArchitectureConfig(path.join(root, CONFIG_FILE));
  let proposal: MigrationProposal;
  try {
    proposal = await new JsonProposalStore(root).load(proposalId);
  } catch (error) {
    if (!(error instanceof PersistenceError)) throw error;
    throw new MigrationSafetyError(
      `Migration proposal is missing or invalid: ${proposalId}`,
      4,
      "stale-proposal",
      { cause: error },
    );
  }
  let snapshot: ArchitectureSnapshot;
  try {
    snapshot = await new JsonSnapshotStore(root).load(proposal.snapshotId);
  } catch (error) {
    if (!(error instanceof PersistenceError)) throw error;
    throw new MigrationSafetyError(
      `Proposal snapshot is missing or invalid: ${proposal.snapshotId}`,
      4,
      "stale-snapshot",
      { cause: error },
    );
  }
  return { config, proposal, snapshot };
};

const timeoutValue = (
  value: string | number | undefined,
): number | undefined => {
  if (value === undefined) return;
  const timeout = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 900_000)
    throw new InvalidInputError(
      `Invalid migration timeout '${value}'; expected 1000 to 900000 milliseconds`,
    );
  return timeout;
};

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const createRepairSuggestion = async (root: string, proposalId: string) => {
  const context = await loadContext(root, proposalId);
  const plan = await prepareMigrationPlan({
    repositoryRoot: root,
    ...context,
    executor: { kind: "codex" },
  });
  return suggestProposalRepair({
    ...context,
    configHash: plan.repository.configHash,
    sourceFingerprint: plan.repository.sourceFingerprint,
  });
};

const suggestedAdditions = (suggestion: ProposalRepairSuggestion): string =>
  suggestion.suggestedCompanionSymbolAdditions
    .map(({ symbol }) => `${symbol.file}#${symbol.name}`)
    .join(", ") || "none";

export const migratePlanCommand = async (
  proposalId: string,
  options: MigratePlanOptions,
): Promise<void> => {
  const root = projectRoot(options);
  const context = await loadContext(root, proposalId);
  const plan = await prepareMigrationPlan({
    repositoryRoot: root,
    ...context,
    executor: { kind: "codex" },
  });
  if (options.json) writeJson(plan);
  else {
    const readiness = plan.readiness;
    const suggestion =
      readiness?.state === "not-ready"
        ? suggestProposalRepair({
            ...context,
            configHash: plan.repository.configHash,
            sourceFingerprint: plan.repository.sourceFingerprint,
          })
        : undefined;
    process.stdout.write(
      [
        `Plan: ${plan.planId}`,
        `Proposal: ${plan.proposalId}`,
        `Base: ${plan.repository.baseCommit}`,
        `Readiness: ${readiness?.state ?? "unknown"}`,
        `Primary symbols: ${readiness?.primarySymbols.map(({ file, name }) => `${file}#${name}`).join(", ") || "none"}`,
        `Required companions: ${readiness?.requiredCompanionSymbols.map(({ file, name }) => `${file}#${name}`).join(", ") || "none"}`,
        `Retained dependencies: ${readiness?.retainedDependencies.map(({ symbol }) => `${symbol.file}#${symbol.name}`).join(", ") || "none"}`,
        `Unresolved dependencies: ${readiness?.unresolvedDependencies.map(({ name }) => name).join(", ") || "none"}`,
        `Predicted imports: ${readiness?.predictedImportEdges.map(({ fromModule, toModule }) => `${fromModule} -> ${toModule}`).join(", ") || "none"}`,
        `Possible cycles: ${readiness?.predictedCycleRisks.map(({ modules }) => modules.join(" -> ")).join(", ") || "none"}`,
        `Blocking reasons: ${readiness?.blockingReasons.map(({ code, message }) => `${code}: ${message}`).join(" | ") || "none"}`,
        `Warnings: ${readiness?.warnings.map(({ code, message }) => `${code}: ${message}`).join(" | ") || "none"}`,
        `Destination: ${plan.expectedChange.destinationDirectory}`,
        `Changed-file limit: ${plan.scope.maximumChangedFiles}`,
        ...(suggestion
          ? [
              `Repair suggestion: ${suggestion.state}`,
              `Suggested companion additions: ${suggestedAdditions(suggestion)}`,
              `Predicted readiness: ${suggestion.predictedReadinessState ?? "unavailable"}`,
              "No proposal was modified or approved; a revised proposal is required before execution.",
            ]
          : []),
        "No worktree was created.",
      ].join("\n") + "\n",
    );
  }
};

export const migrateSuggestCommand = async (
  proposalId: string,
  options: MigrateSuggestOptions,
): Promise<void> => {
  const suggestion = await createRepairSuggestion(
    projectRoot(options),
    proposalId,
  );
  if (options.json) {
    writeJson(suggestion);
    return;
  }
  process.stdout.write(
    [
      `Suggestion: ${suggestion.state}`,
      `Suggestion ID: ${suggestion.suggestionId}`,
      `Proposal: ${suggestion.baseProposalId}`,
      `Current readiness: ${suggestion.currentReadinessState}`,
      `Predicted readiness: ${suggestion.predictedReadinessState ?? "unavailable"}`,
      `Current approved companion symbols: ${suggestion.currentApprovedCompanionSymbols.map(({ file, name }) => `${file}#${name}`).join(", ") || "none"}`,
      "Add approved companion symbols:",
      ...(suggestion.suggestedCompanionSymbolAdditions.length > 0
        ? suggestion.suggestedCompanionSymbolAdditions.flatMap(
            ({ symbol, rationale, omissionBlockingReasons }) => [
              `- ${symbol.file}#${symbol.name}`,
              `  Reason: ${rationale}`,
              `  Omission blockers: ${omissionBlockingReasons.map(({ code, message }) => `${code}: ${message}`).join(" | ") || "none"}`,
            ],
          )
        : ["- none"]),
      `Remaining blockers: ${suggestion.remainingBlockers.map(({ code, message }) => `${code}: ${message}`).join(" | ") || "none"}`,
      `Retained dependencies: ${suggestion.retainedDependencies.map(({ symbol }) => `${symbol.file}#${symbol.name}`).join(", ") || "none"}`,
      `Safely imported dependencies: ${
        suggestion.safelyImportedDependencies
          .map(({ kind, dependency }) =>
            kind === "internal"
              ? `${dependency.symbol.file}#${dependency.symbol.name}`
              : `${dependency.package}:${dependency.name}`,
          )
          .join(", ") || "none"
      }`,
      `Unresolved dependencies: ${suggestion.unresolvedDependencies.map(({ name }) => name).join(", ") || "none"}`,
      `Predicted imports: ${suggestion.predictedImportEdges.map(({ fromModule, toModule }) => `${fromModule} -> ${toModule}`).join(", ") || "none"}`,
      `Predicted cycles: ${suggestion.predictedCycleRisks.map(({ modules }) => modules.join(" -> ")).join(", ") || "none"}`,
      `Warnings: ${suggestion.warnings.map(({ code, message }) => `${code}: ${message}`).join(" | ") || "none"}`,
      `Minimal: ${suggestion.minimal ? "yes" : "no"}`,
      "No proposal was modified or approved.",
      "Create or approve a revised proposal before execution.",
    ].join("\n") + "\n",
  );
};

export const migrateRunCommand = async (
  proposalId: string,
  options: MigrateRunOptions,
  dependencies: MigrateRunDependencies = {},
): Promise<void> => {
  if ((options.executor ?? "codex") !== "codex")
    throw new InvalidInputError(
      "Phase 3 production migration supports --executor codex only",
    );
  const root = projectRoot(options);
  const context = await loadContext(root, proposalId);
  const timeoutMs = timeoutValue(options.timeout);
  const executor =
    dependencies.executorFactory?.(context.config) ??
    new CodexExecutor({
      executable: context.config.migration.codex.executable,
    });
  if (executor.kind !== "codex")
    throw new InvalidInputError(
      "The production migrate command cannot use the scripted-test executor",
    );
  const result = await runMigration({
    repositoryRoot: root,
    ...context,
    ...(options.approve === undefined ? {} : { approval: options.approve }),
    executor: {
      kind: "codex",
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort
        ? { reasoningEffort: options.reasoningEffort }
        : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    migrationExecutor: executor,
    executionId: dependencies.executionIdFactory?.() ?? createExecutionId(),
    createCommit: options.commit !== false,
  });
  if (options.json) writeJson(result.record);
  else
    process.stdout.write(
      [
        `Execution: ${result.executionId}`,
        `Status: ${result.record.status}`,
        `Plan: ${result.plan.planId}`,
        `Candidate branch: ${result.record.candidateBranch ?? "not created"}`,
        `Candidate commit: ${result.record.candidateCommit ?? "not created (--no-commit)"}`,
        "Merge: disabled",
        "Push: disabled",
      ].join("\n") + "\n",
    );
};

export const migrateListCommand = async (
  options: ProjectOptions,
): Promise<void> => {
  const records = await new JsonExecutionStore(
    projectRoot(options),
  ).listRecords();
  if (options.json) writeJson(records);
  else if (records.length === 0)
    process.stdout.write("No migration executions.\n");
  else
    process.stdout.write(
      `${records
        .map(
          (record) =>
            `${record.executionId}\t${record.status}\t${record.proposalId}\t${record.candidateBranch ?? "-"}`,
        )
        .join("\n")}\n`,
    );
};

export const migrateStatusCommand = async (
  executionId: string,
  options: ProjectOptions,
): Promise<void> => {
  const record = await new JsonExecutionStore(projectRoot(options)).loadRecord(
    executionId,
  );
  if (options.json) writeJson(record);
  else
    process.stdout.write(
      [
        `Execution: ${record.executionId}`,
        `Status: ${record.status}`,
        `Proposal: ${record.proposalId}`,
        `Candidate branch: ${record.candidateBranch ?? "-"}`,
        `Candidate commit: ${record.candidateCommit ?? "-"}`,
        ...(record.failure
          ? [`Failure: ${record.failure.code}: ${record.failure.message}`]
          : []),
      ].join("\n") + "\n",
    );
};

export const migrateInspectCommand = async (
  executionId: string,
  options: ProjectOptions,
): Promise<void> => {
  const store = new JsonExecutionStore(projectRoot(options));
  const [plan, record] = await Promise.all([
    store.loadPlan(executionId),
    store.loadRecord(executionId),
  ]);
  writeJson({ plan, record });
};

export const migrateDiffCommand = async (
  executionId: string,
  options: ProjectOptions,
): Promise<void> => {
  const root = projectRoot(options);
  await new JsonExecutionStore(root).loadRecord(executionId);
  try {
    process.stdout.write(
      await readFile(
        path.join(root, EXECUTIONS_DIRECTORY, executionId, "candidate.patch"),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stdout.write(`No candidate patch for ${executionId}.\n`);
      return;
    }
    throw error;
  }
};

export const migrateDiscardCommand = async (
  executionId: string,
  options: MigrateDiscardOptions,
): Promise<void> => {
  if (options.confirm !== executionId)
    throw new MigrationSafetyError(
      `Discard confirmation must exactly equal ${executionId}`,
      12,
      "discard-confirmation-mismatch",
    );
  const root = projectRoot(options);
  const store = new JsonExecutionStore(root);
  const record = await store.loadRecord(executionId);
  if (record.status === "discarded") {
    if (options.json) writeJson(record);
    else
      process.stdout.write(
        `Discarded ${executionId}; portable record and patch retained.\n`,
      );
    return;
  }
  const manager = new WorktreeManager({
    repositoryRoot: root,
    executionRoot: defaultExecutionRoot(root),
  });
  const mainIntegrityOptions = {
    ownedCandidateRef: `refs/heads/${candidateBranchForExecution(executionId)}`,
    ownedWorktreeGitDirectory: await manager.gitDirectory(executionId),
  } as const;
  const mainBefore = await captureMainCheckoutState(root, mainIntegrityOptions);
  await manager.discard(executionId);
  const mainAfter = await captureMainCheckoutState(root, mainIntegrityOptions);
  assertMainCheckoutIntegrity(mainBefore, mainAfter);
  const discarded = {
    ...record,
    status: "discarded" as const,
    completedAt: new Date().toISOString(),
    fingerprints: {
      ...record.fingerprints,
      mainAfter: mainAfter.fingerprint,
    },
  };
  await store.saveRecord(discarded);
  if (options.json) writeJson(discarded);
  else
    process.stdout.write(
      `Discarded ${executionId}; portable record and patch retained.\n`,
    );
};
