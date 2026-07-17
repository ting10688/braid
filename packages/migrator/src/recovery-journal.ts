import path from "node:path";
import {
  RECOVERY_JOURNAL_SCHEMA_VERSION,
  type MigrationRecoveryCheckpoint,
  type MigrationRecoveryEvidence,
  type MigrationRecoveryIdentity,
  type MigrationRecoveryJournalEntry,
  type MigrationResourceOwnership,
} from "@braid/core";
import {
  JsonRecoveryJournalStore,
  type RecoveryJournalStore,
} from "@braid/store";
import { EXECUTIONS_DIRECTORY } from "@braid/shared";
import {
  createResourceOwnership,
  recoveryHash,
  recoveryJournalId,
} from "./recovery-support.js";

export interface RecoveryJournalContext {
  executionId: string;
  proposalId: string;
  planId: string;
  baseCommit: string;
  identity: MigrationRecoveryIdentity;
  journalId: string;
}

export const createRecoveryJournalContext = (input: {
  executionId: string;
  proposalId: string;
  planId: string;
  baseCommit: string;
  identity: MigrationRecoveryIdentity;
}): RecoveryJournalContext => ({
  ...input,
  journalId: recoveryJournalId(input),
});

export const appendRecoveryCheckpoint = async (input: {
  context: RecoveryJournalContext;
  evidence: MigrationRecoveryEvidence;
  store: RecoveryJournalStore;
  now?: () => Date;
  diagnostics?: string[];
}): Promise<MigrationRecoveryJournalEntry> =>
  input.store.appendEntry({
    schemaVersion: RECOVERY_JOURNAL_SCHEMA_VERSION,
    journalId: input.context.journalId,
    executionId: input.context.executionId,
    proposalId: input.context.proposalId,
    planId: input.context.planId,
    baseCommit: input.context.baseCommit,
    checkpoint: input.evidence.checkpoint,
    identity: input.context.identity,
    evidence: input.evidence,
    recordedAt: (input.now?.() ?? new Date()).toISOString(),
    diagnostics: input.diagnostics ?? [],
  });

export const recoveryDirectory = (
  repositoryRoot: string,
  executionId: string,
): string =>
  path.join(repositoryRoot, EXECUTIONS_DIRECTORY, executionId, "recovery");

export const recoveryArtifactLocator = (
  executionId: string,
  name: string,
): string =>
  path.posix.join(
    EXECUTIONS_DIRECTORY.split(path.sep).join("/"),
    executionId,
    "recovery",
    name,
  );

const intentIntegrity = (input: {
  resourceType: string;
  executionId: string;
  repositoryId: string;
  baseCommit: string;
  portableLocator: string;
  creationCheckpoint: MigrationRecoveryCheckpoint;
  semanticIdentity?: unknown;
}): string => recoveryHash(input);

export const createRecoveryResourceIntent = (input: {
  resourceType: MigrationResourceOwnership["resourceType"];
  executionId: string;
  repositoryId: string;
  baseCommit: string;
  portableLocator: string;
  creationCheckpoint: MigrationRecoveryCheckpoint;
  semanticIdentity?: unknown;
  gitIdentity?: MigrationResourceOwnership["gitIdentity"];
}): MigrationResourceOwnership =>
  createResourceOwnership({
    ...input,
    integrityHash: intentIntegrity(input),
  });

export const defaultRecoveryJournalStore = (
  repositoryRoot: string,
): RecoveryJournalStore => new JsonRecoveryJournalStore(repositoryRoot);

export const checkpointEntry = (
  entries: readonly MigrationRecoveryJournalEntry[],
  checkpoint: MigrationRecoveryCheckpoint,
): MigrationRecoveryJournalEntry | undefined =>
  entries.find((entry) => entry.checkpoint === checkpoint);

export const latestRecoveryCheckpoint = (
  entries: readonly MigrationRecoveryJournalEntry[],
): MigrationRecoveryCheckpoint | null => entries.at(-1)?.checkpoint ?? null;

export const recoveryResources = (
  entries: readonly MigrationRecoveryJournalEntry[],
): MigrationResourceOwnership[] => {
  const resources = entries.flatMap(({ evidence }) => {
    switch (evidence.checkpoint) {
      case "planned":
        return evidence.resources;
      case "staging-created":
        return [
          evidence.stagingResource,
          evidence.candidateWorktreeResource,
          evidence.candidateRefResource,
        ];
      case "executor-started":
        return [evidence.processResource];
      case "patch-captured":
        return [evidence.patchResource];
      case "candidate-prepared":
        return [evidence.indexResource];
      default:
        return [];
    }
  });
  return [
    ...new Map(
      resources.map((resource) => [resource.resourceId, resource]),
    ).values(),
  ].sort((left, right) => left.resourceId.localeCompare(right.resourceId));
};
