export {
  createExecutionPlan,
  type CreateExecutionPlanInput,
} from "./execution-plan.js";
export {
  evaluateExecutionReadiness,
  READINESS_ALGORITHM_VERSION,
  READINESS_REJECTION_EXIT_CODE,
  type EvaluateExecutionReadinessInput,
} from "./execution-readiness.js";
export {
  REPAIR_SUGGESTION_ALGORITHM_VERSION,
  suggestProposalRepair,
  type SuggestProposalRepairInput,
} from "./proposal-repair-suggestion.js";
export {
  runPreflight,
  type PreflightInput,
  type PreflightResult,
} from "./preflight.js";
export { createSourceFingerprint } from "./source-fingerprint.js";
export {
  createExecutorStagingRepository,
  durableExecutorStagingPath,
  loadExecutorStagingRepository,
  type DurableExecutorStagingIdentity,
  type DurableExecutorStagingOptions,
  type ExecutorStagingRepository,
} from "./executor-staging.js";
export {
  FORBIDDEN_FILE_PATTERNS,
  MIGRATOR_VERSION,
  SCOPE_POLICY_VERSION,
} from "./safety.js";
export {
  assertExecutorDidNotCommit,
  createPreparedCandidateCommit,
  createCandidateCommit,
  prepareCandidateCommit,
  type CandidateCommitPreparation,
  type PrepareCandidateCommitInput,
} from "./candidate-commit.js";
export {
  assertMainCheckoutIntegrity,
  captureMainCheckoutState,
  type CaptureMainCheckoutStateOptions,
  type MainCheckoutState,
} from "./main-integrity.js";
export {
  candidateBranchForExecution,
  defaultExecutionRoot,
  WorktreeManager,
  type OwnedWorktree,
} from "./worktree-manager.js";
export type {
  ExecutorContext,
  ExecutorEnvironment,
  ExecutorEvent,
  ExecutorResult,
  MigrationExecutor,
} from "./executors/executor.js";
export {
  CodexExecutor,
  type CodexApprovalPolicyArgument,
  type CodexExecutorEnvironment,
  type CodexExecutorOptions,
  type CodexInspector,
  type CodexProcessSpawner,
  type CodexWorkingDirectoryArgument,
} from "./executors/codex-executor.js";
export {
  ScriptedTestExecutor,
  type ScriptedExecution,
} from "./executors/scripted-test-executor.js";
export {
  buildMigrationPrompt,
  CODEX_MIGRATION_SUMMARY_JSON_SCHEMA,
} from "./prompt-builder.js";
export {
  capturePatchFileModes,
  hashNormalizedPatch,
  inspectMigrationScope,
  pathMatchesPattern,
  type InspectMigrationScopeInput,
  type ModeChange,
  type PatchFileMode,
  type RenamedFile,
  type ScopeInspection,
  type ScopeLineStats,
} from "./scope-policy.js";
export {
  assertSafeValidationCommand,
  runValidationCommands,
  type RunValidationCommandsInput,
  type ValidationSummary,
} from "./validation-runner.js";
export {
  compareMigrationImpact,
  type ArchitectureValidationResult,
  type CompareMigrationImpactInput,
} from "./impact-comparison.js";
export {
  captureSafetySurface,
  compareSafetySurfaces,
  type SafetySurface,
  type SafetySurfaceEntry,
} from "./safety-surface.js";
export {
  createExecutionId,
  prepareMigrationPlan,
  runMigration,
  type MigrationRunResult,
  type PrepareMigrationPlanInput,
  type RunMigrationInput,
} from "./migration-orchestrator.js";
export {
  cleanupMigrationRecovery,
  resumeMigration,
  type CleanupMigrationRecoveryInput,
  type ResumeMigrationInput,
} from "./migration-recovery.js";
export {
  inspectMigrationRecovery,
  listMigrationRecoveries,
  type InspectMigrationRecoveryInput,
} from "./recovery-inspector.js";
export {
  acquireExecutionLock,
  inspectExecutionLock,
  type AcquiredExecutionLock,
  type ExecutionLockInspection,
  type ExecutionLockStatus,
} from "./execution-lock.js";
