import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  codexMigrationSummarySchema,
  migrationResourceOwnershipSchema,
  type CodexMigrationSummary,
  type MigrationRecoveryJournalEntry,
  type MigrationRecoveryIdentity,
  type MigrationResourceOwnership,
  type MigrationResourceType,
} from "@braid/core";
import type { ExecutorEvent } from "./executors/executor.js";

const execFileAsync = promisify(execFile);

export type RecoveryInternalTestEvent =
  | "planned"
  | "preflight-passed"
  | "staging-created"
  | "executor-started"
  | "executor-finished"
  | "patch-captured"
  | "scope-verified"
  | "validation-passed"
  | "architecture-passed"
  | "candidate-prepared"
  | "candidate-created"
  | "completed"
  | "candidate-object-created"
  | "candidate-ref-updated"
  | "execution-record-written-before-completed";

export const notifyRecoveryInternalTestEvent = async (
  event: RecoveryInternalTestEvent,
): Promise<void> => {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.BRAID_INTERNAL_TEST_PAUSE_AFTER_RECOVERY_EVENT !== event
  )
    return;
  const markerInput = process.env.BRAID_INTERNAL_TEST_PAUSE_MARKER;
  if (!markerInput)
    throw new Error("Recovery interruption test marker is required");
  const marker = path.resolve(markerInput);
  const temporaryRoot = path.resolve(tmpdir());
  const relative = path.relative(temporaryRoot, marker);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Recovery interruption test marker must be under tmpdir");
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, `${event}\n`, { encoding: "utf8", flag: "wx" });
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
  });
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const stableRecoveryValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableRecoveryValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, item]) => [key, stableRecoveryValue(item)]),
    );
  return value;
};

export const recoveryHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stableRecoveryValue(value)))
    .digest("hex");

export interface DurableRecoveryExecutorResult {
  invocationId: string;
  exitCode: number | null;
  timedOut: boolean;
  events: ExecutorEvent[];
  stderr: string;
  summary?: CodexMigrationSummary;
  stagingFingerprint: string;
  eventLog?: string;
}

type ExecutorFinishedEvidence = Extract<
  MigrationRecoveryJournalEntry["evidence"],
  { checkpoint: "executor-finished" }
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isExecutorEvent = (value: unknown): value is ExecutorEvent => {
  if (!isRecord(value)) return false;
  if (
    !new Set(["command", "file-change", "message", "usage"]).has(
      String(value.type),
    )
  )
    return false;
  if (value.timestamp !== undefined && typeof value.timestamp !== "string")
    return false;
  if (
    value.command !== undefined &&
    (!Array.isArray(value.command) ||
      !value.command.every((item) => typeof item === "string"))
  )
    return false;
  if (value.path !== undefined && typeof value.path !== "string") return false;
  if (value.message !== undefined && typeof value.message !== "string")
    return false;
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) return false;
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"])
      if (
        value.usage[key] !== undefined &&
        (typeof value.usage[key] !== "number" ||
          !Number.isFinite(value.usage[key]))
      )
        return false;
  }
  return true;
};

export const parseDurableRecoveryExecutorResult = (
  value: unknown,
): DurableRecoveryExecutorResult => {
  if (
    !isRecord(value) ||
    typeof value.invocationId !== "string" ||
    value.invocationId.length === 0 ||
    !(
      value.exitCode === null ||
      (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))
    ) ||
    typeof value.timedOut !== "boolean" ||
    !Array.isArray(value.events) ||
    !value.events.every(isExecutorEvent) ||
    typeof value.stderr !== "string" ||
    typeof value.stagingFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.stagingFingerprint) ||
    (value.eventLog !== undefined && typeof value.eventLog !== "string")
  )
    throw new Error("Durable executor result artifact is structurally invalid");
  const summary =
    value.summary === undefined
      ? undefined
      : codexMigrationSummarySchema.parse(value.summary);
  return {
    invocationId: value.invocationId,
    exitCode: value.exitCode,
    timedOut: value.timedOut,
    events: value.events,
    stderr: value.stderr,
    ...(summary ? { summary } : {}),
    stagingFingerprint: value.stagingFingerprint,
    ...(value.eventLog ? { eventLog: value.eventLog } : {}),
  };
};

export const executorFinishedEvidenceFor = (
  result: DurableRecoveryExecutorResult,
): ExecutorFinishedEvidence => ({
  checkpoint: "executor-finished",
  invocationId: result.invocationId,
  exitCode: result.exitCode ?? -1,
  timedOut: result.timedOut,
  stdoutHash: recoveryHash({
    events: result.events,
    summary: result.summary,
  }),
  stderrHash: recoveryHash(result.stderr),
  cleanupHash: recoveryHash({
    invocationId: result.invocationId,
    processGroupClean: true,
  }),
  processGroupClean: true,
  stagingFingerprint: result.stagingFingerprint,
});

export const assertExecutorResultMatchesFinishedEvidence = (
  value: unknown,
  expected: ExecutorFinishedEvidence,
): DurableRecoveryExecutorResult => {
  const result = parseDurableRecoveryExecutorResult(value);
  if (
    recoveryHash(executorFinishedEvidenceFor(result)) !== recoveryHash(expected)
  )
    throw new Error("Executor result artifact does not match the journal");
  return result;
};

const git = async (
  repositoryRoot: string,
  arguments_: string[],
): Promise<string> =>
  (
    await execFileAsync("git", ["-C", repositoryRoot, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim();

export interface RecoveryRepositoryIdentity {
  repositoryId: string;
  gitCommonDirectoryId: string;
  originatingWorktreeId: string;
}

export const captureRecoveryRepositoryIdentity = async (
  repositoryRootInput: string,
): Promise<RecoveryRepositoryIdentity> => {
  const repositoryRoot = await realpath(path.resolve(repositoryRootInput));
  const [commonInput, gitDirectoryInput, objectFormat, rootCommitsOutput] =
    await Promise.all([
      git(repositoryRoot, ["rev-parse", "--git-common-dir"]),
      git(repositoryRoot, ["rev-parse", "--git-dir"]),
      git(repositoryRoot, ["rev-parse", "--show-object-format"]),
      git(repositoryRoot, ["rev-list", "--max-parents=0", "HEAD"]),
    ]);
  const commonDirectory = await realpath(
    path.resolve(repositoryRoot, commonInput),
  );
  const gitDirectory = await realpath(
    path.resolve(repositoryRoot, gitDirectoryInput),
  );
  const relativeGitDirectory = path.relative(commonDirectory, gitDirectory);
  if (
    relativeGitDirectory.startsWith("..") ||
    path.isAbsolute(relativeGitDirectory)
  )
    throw new Error("Git worktree directory is outside its common directory");
  const rootCommits = rootCommitsOutput
    .split("\n")
    .filter(Boolean)
    .sort(compare);
  const repositoryId = recoveryHash({ objectFormat, rootCommits });
  const gitCommonDirectoryId = recoveryHash({
    repositoryId,
    kind: "git-common-directory",
  });
  const originatingWorktreeId = recoveryHash({
    repositoryId,
    gitDirectoryLocator:
      relativeGitDirectory === ""
        ? "."
        : relativeGitDirectory.split(path.sep).join("/"),
  });
  return {
    repositoryId,
    gitCommonDirectoryId,
    originatingWorktreeId,
  };
};

export const createRecoveryIdentity = (input: {
  repository: RecoveryRepositoryIdentity;
  configHash: string;
  sourceFingerprint: string;
  approval: string;
  plan: unknown;
  proposal: unknown;
}): MigrationRecoveryIdentity => ({
  repositoryId: input.repository.repositoryId,
  gitCommonDirectoryId: input.repository.gitCommonDirectoryId,
  originatingWorktreeId: input.repository.originatingWorktreeId,
  configHash: input.configHash,
  sourceFingerprint: input.sourceFingerprint,
  approvalHash: recoveryHash(input.approval),
  planHash: recoveryHash(input.plan),
  proposalHash: recoveryHash(input.proposal),
});

export const recoveryJournalId = (input: {
  executionId: string;
  proposalId: string;
  planId: string;
  baseCommit: string;
  identity: MigrationRecoveryIdentity;
}): string => `RJ-${recoveryHash(input).slice(0, 16)}`;

export const recoveryReportId = (input: {
  executionId: string;
  journalId: string | null;
  latestCheckpoint: string | null;
  latestSequence: number | null;
  classification: string;
}): string => `RR-${recoveryHash(input).slice(0, 16)}`;

export const executorInvocationId = (input: {
  executionId: string;
  planId: string;
  executorConfiguration: unknown;
}): string => `INV-${recoveryHash(input).slice(0, 24)}`;

export const createResourceOwnership = (input: {
  resourceType: MigrationResourceType;
  executionId: string;
  repositoryId: string;
  baseCommit: string;
  portableLocator: string;
  creationCheckpoint: MigrationResourceOwnership["creationCheckpoint"];
  integrityHash: string;
  gitIdentity?: MigrationResourceOwnership["gitIdentity"];
}): MigrationResourceOwnership => {
  const semantic = {
    resourceType: input.resourceType,
    executionId: input.executionId,
    repositoryId: input.repositoryId,
    baseCommit: input.baseCommit,
    portableLocator: input.portableLocator,
    creationCheckpoint: input.creationCheckpoint,
    integrityHash: input.integrityHash,
    ...(input.gitIdentity ? { gitIdentity: input.gitIdentity } : {}),
  };
  return migrationResourceOwnershipSchema.parse({
    resourceId: `R-${recoveryHash(semantic).slice(0, 24)}`,
    ...semantic,
  });
};

export const assertSameResourceOwnership = (
  expected: MigrationResourceOwnership,
  actual: MigrationResourceOwnership,
): void => {
  if (recoveryHash(expected) !== recoveryHash(actual))
    throw new Error(
      `Recovery resource ${expected.resourceId} does not match durable ownership evidence`,
    );
};

export type RecoveryProcessMetadataState = "prepared" | "launching";

export interface RecoveryProcessMetadata {
  schemaVersion: 1;
  state: RecoveryProcessMetadataState;
  ownership: MigrationResourceOwnership;
  integrityHash: string;
}

export const createRecoveryProcessMetadata = (
  ownership: MigrationResourceOwnership,
  state: RecoveryProcessMetadataState,
): RecoveryProcessMetadata => {
  const semantic = { schemaVersion: 1 as const, state, ownership };
  return { ...semantic, integrityHash: recoveryHash(semantic) };
};

export const parseRecoveryProcessMetadata = (
  value: unknown,
  expectedOwnership: MigrationResourceOwnership,
): RecoveryProcessMetadata => {
  if (!isRecord(value))
    throw new Error("Recovery process metadata is not an object");
  const state = value.state;
  const ownership = migrationResourceOwnershipSchema.parse(value.ownership);
  const semantic = {
    schemaVersion: value.schemaVersion,
    state,
    ownership,
  };
  if (
    value.schemaVersion !== 1 ||
    (state !== "prepared" && state !== "launching") ||
    typeof value.integrityHash !== "string" ||
    value.integrityHash !== recoveryHash(semantic) ||
    recoveryHash(ownership) !== recoveryHash(expectedOwnership)
  )
    throw new Error("Recovery process metadata integrity is invalid");
  return value as unknown as RecoveryProcessMetadata;
};
