import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  migrationRecoveryJournalEntrySchema,
  type MigrationRecoveryCheckpoint,
  type MigrationRecoveryJournalEntry,
} from "@braid/core";
import { EXECUTIONS_DIRECTORY, PersistenceError } from "@braid/shared";

type WithoutJournalHashes<Entry> = Entry extends unknown
  ? Omit<Entry, "sequence" | "previousEntryHash" | "semanticHash" | "entryHash">
  : never;

export type RecoveryJournalEntryInput =
  WithoutJournalHashes<MigrationRecoveryJournalEntry>;

export interface RecoveryJournalIntegrity {
  valid: boolean;
  code?: string;
  message?: string;
  temporaryFiles: string[];
}

export interface LoadedRecoveryJournal {
  entries: MigrationRecoveryJournalEntry[];
  integrity: RecoveryJournalIntegrity;
}

export interface RecoveryJournalStore {
  appendEntry(
    input: RecoveryJournalEntryInput,
  ): Promise<MigrationRecoveryJournalEntry>;
  loadJournal(executionId: string): Promise<LoadedRecoveryJournal>;
  listExecutionIds(): Promise<string[]>;
}

const executionIdPattern =
  /^E-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const entryFilePattern = /^(\d{6})-([a-z]+(?:-[a-z]+)*)\.json$/u;
const allowedTransitions = new Map<
  MigrationRecoveryCheckpoint,
  readonly MigrationRecoveryCheckpoint[]
>([
  ["planned", ["preflight-passed", "failed", "discarded"]],
  ["preflight-passed", ["staging-created", "failed", "discarded"]],
  ["staging-created", ["executor-started", "failed", "discarded"]],
  ["executor-started", ["executor-finished", "failed", "discarded"]],
  ["executor-finished", ["patch-captured", "failed", "discarded"]],
  ["patch-captured", ["scope-verified", "failed", "discarded"]],
  ["scope-verified", ["validation-passed", "failed", "discarded"]],
  ["validation-passed", ["architecture-passed", "failed", "discarded"]],
  [
    "architecture-passed",
    ["candidate-prepared", "completed", "failed", "discarded"],
  ],
  ["candidate-prepared", ["candidate-created", "failed", "discarded"]],
  ["candidate-created", ["completed", "failed", "discarded"]],
  ["completed", []],
  ["failed", []],
  ["discarded", []],
]);

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(stableValue(value));

const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const semanticContent = (
  entry: RecoveryJournalEntryInput | MigrationRecoveryJournalEntry,
) => ({
  schemaVersion: entry.schemaVersion,
  journalId: entry.journalId,
  executionId: entry.executionId,
  proposalId: entry.proposalId,
  planId: entry.planId,
  baseCommit: entry.baseCommit,
  checkpoint: entry.checkpoint,
  identity: entry.identity,
  evidence: entry.evidence,
});

const identityContent = (entry: MigrationRecoveryJournalEntry) => ({
  journalId: entry.journalId,
  executionId: entry.executionId,
  proposalId: entry.proposalId,
  planId: entry.planId,
  baseCommit: entry.baseCommit,
  identity: entry.identity,
});

const entryContent = (entry: MigrationRecoveryJournalEntry) => {
  const { entryHash: _entryHash, ...content } = entry;
  void _entryHash;
  return content;
};

const formatSequence = (sequence: number): string =>
  sequence.toString().padStart(6, "0");

const entryFileName = (
  sequence: number,
  checkpoint: MigrationRecoveryCheckpoint,
): string => `${formatSequence(sequence)}-${checkpoint}.json`;

const assertExecutionId = (executionId: string): void => {
  if (!executionIdPattern.test(executionId))
    throw new PersistenceError(`Invalid execution ID: ${executionId}`);
};

const invalidJournal = (
  entries: MigrationRecoveryJournalEntry[],
  temporaryFiles: string[],
  code: string,
  message: string,
): LoadedRecoveryJournal => ({
  entries,
  integrity: { valid: false, code, message, temporaryFiles },
});

const withAppendLock = async <T>(
  lock: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const deadline = Date.now() + 5_000;
  await mkdir(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new PersistenceError("Could not acquire recovery journal lock", {
          cause: error,
        });
      try {
        const metadata = await stat(lock);
        if (Date.now() - metadata.mtimeMs > 30_000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT")
          throw new PersistenceError(
            "Could not inspect recovery journal lock",
            {
              cause: inspectionError,
            },
          );
      }
      if (Date.now() >= deadline)
        throw new PersistenceError("Timed out acquiring recovery journal lock");
      await delay(10);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

export class JsonRecoveryJournalStore implements RecoveryJournalStore {
  constructor(private readonly projectRoot: string) {}

  async appendEntry(
    input: RecoveryJournalEntryInput,
  ): Promise<MigrationRecoveryJournalEntry> {
    assertExecutionId(input.executionId);
    const recoveryDirectory = path.join(
      this.projectRoot,
      EXECUTIONS_DIRECTORY,
      input.executionId,
      "recovery",
    );
    return withAppendLock(
      path.join(recoveryDirectory, ".append.lock"),
      async () => {
        const journal = await this.loadJournal(input.executionId);
        if (!journal.integrity.valid)
          throw new PersistenceError(
            `Cannot append to invalid recovery journal: ${journal.integrity.code ?? "unknown"}`,
          );

        const semanticHash = sha256(semanticContent(input));
        const replay = journal.entries.find(
          ({ checkpoint }) => checkpoint === input.checkpoint,
        );
        if (replay) {
          if (replay.semanticHash === semanticHash) return replay;
          throw new PersistenceError(
            `Recovery checkpoint ${input.checkpoint} already contains different content`,
          );
        }

        const previous = journal.entries.at(-1);
        if (
          previous === undefined
            ? input.checkpoint !== "planned"
            : !allowedTransitions
                .get(previous.checkpoint)
                ?.includes(input.checkpoint)
        )
          throw new PersistenceError(
            `Illegal recovery checkpoint transition ${previous?.checkpoint ?? "empty"} -> ${input.checkpoint}`,
          );

        const sequence = journal.entries.length;
        const unsigned = {
          ...input,
          sequence,
          previousEntryHash: previous?.entryHash ?? null,
          semanticHash,
        };
        const entry = migrationRecoveryJournalEntrySchema.parse({
          ...unsigned,
          entryHash: sha256(unsigned),
        });
        const directory = path.join(recoveryDirectory, "entries");
        const fileName = entryFileName(sequence, input.checkpoint);
        const destination = path.join(directory, fileName);
        const temporary = path.join(
          directory,
          `.${fileName}-${randomUUID()}.tmp`,
        );

        try {
          await mkdir(directory, { recursive: true });
          await writeFile(
            temporary,
            `${JSON.stringify(stableValue(entry), null, 2)}\n`,
            { encoding: "utf8", flag: "wx" },
          );
          try {
            await stat(destination);
            throw new PersistenceError(
              `Recovery checkpoint ${entry.checkpoint} already exists`,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await rename(temporary, destination);
          return entry;
        } catch (error) {
          if (error instanceof PersistenceError) throw error;
          throw new PersistenceError(
            `Could not persist recovery checkpoint ${entry.checkpoint}`,
            { cause: error },
          );
        } finally {
          await rm(temporary, { force: true });
        }
      },
    );
  }

  async loadJournal(executionId: string): Promise<LoadedRecoveryJournal> {
    assertExecutionId(executionId);
    const directory = path.join(
      this.projectRoot,
      EXECUTIONS_DIRECTORY,
      executionId,
      "recovery",
      "entries",
    );
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          entries: [],
          integrity: { valid: true, temporaryFiles: [] },
        };
      throw new PersistenceError("Could not read recovery journal", {
        cause: error,
      });
    }

    const temporaryFiles = names
      .filter((name) => name.endsWith(".tmp"))
      .sort(compare);
    const files = names.filter((name) => name.endsWith(".json")).sort(compare);
    const entries: MigrationRecoveryJournalEntry[] = [];
    let initialIdentity: string | undefined;
    const seenCheckpoints = new Set<MigrationRecoveryCheckpoint>();

    for (const [index, fileName] of files.entries()) {
      const match = entryFilePattern.exec(fileName);
      if (!match)
        return invalidJournal(
          entries,
          temporaryFiles,
          "filename-mismatch",
          `Invalid recovery journal entry filename ${fileName}`,
        );
      const fileSequence = Number.parseInt(match[1]!, 10);
      if (fileSequence !== index)
        return invalidJournal(
          entries,
          temporaryFiles,
          "missing-sequence",
          `Recovery journal is missing sequence ${formatSequence(index)}`,
        );

      let entry: MigrationRecoveryJournalEntry;
      try {
        entry = migrationRecoveryJournalEntrySchema.parse(
          JSON.parse(await readFile(path.join(directory, fileName), "utf8")),
        );
      } catch {
        return invalidJournal(
          entries,
          temporaryFiles,
          "invalid-entry",
          `Recovery journal entry ${fileName} is malformed`,
        );
      }

      if (entryFileName(entry.sequence, entry.checkpoint) !== fileName)
        return invalidJournal(
          entries,
          temporaryFiles,
          "filename-mismatch",
          `Recovery journal entry ${fileName} does not match its content`,
        );
      if (entry.executionId !== executionId)
        return invalidJournal(
          entries,
          temporaryFiles,
          "identity-drift",
          `Recovery journal entry ${fileName} changed execution identity`,
        );
      if (entry.semanticHash !== sha256(semanticContent(entry)))
        return invalidJournal(
          entries,
          temporaryFiles,
          "semantic-hash-mismatch",
          `Recovery journal entry ${fileName} has an invalid semantic hash`,
        );
      if (entry.entryHash !== sha256(entryContent(entry)))
        return invalidJournal(
          entries,
          temporaryFiles,
          "entry-hash-mismatch",
          `Recovery journal entry ${fileName} has an invalid entry hash`,
        );
      const expectedPrevious = entries.at(-1)?.entryHash ?? null;
      if (entry.previousEntryHash !== expectedPrevious)
        return invalidJournal(
          entries,
          temporaryFiles,
          "previous-entry-hash-mismatch",
          `Recovery journal entry ${fileName} has a broken hash chain`,
        );

      const identity = canonicalJson(identityContent(entry));
      initialIdentity ??= identity;
      if (identity !== initialIdentity)
        return invalidJournal(
          entries,
          temporaryFiles,
          "identity-drift",
          `Recovery journal entry ${fileName} changed immutable identity`,
        );
      if (seenCheckpoints.has(entry.checkpoint))
        return invalidJournal(
          entries,
          temporaryFiles,
          "conflicting-checkpoint",
          `Recovery journal checkpoint ${entry.checkpoint} is duplicated`,
        );

      const previous = entries.at(-1);
      if (
        previous === undefined
          ? entry.checkpoint !== "planned"
          : !allowedTransitions
              .get(previous.checkpoint)
              ?.includes(entry.checkpoint)
      )
        return invalidJournal(
          entries,
          temporaryFiles,
          "illegal-transition",
          `Illegal recovery checkpoint transition ${previous?.checkpoint ?? "empty"} -> ${entry.checkpoint}`,
        );

      seenCheckpoints.add(entry.checkpoint);
      entries.push(entry);
    }

    return {
      entries,
      integrity: { valid: true, temporaryFiles },
    };
  }

  async listExecutionIds(): Promise<string[]> {
    const directory = path.join(this.projectRoot, EXECUTIONS_DIRECTORY);
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter(
          (entry) => entry.isDirectory() && executionIdPattern.test(entry.name),
        )
        .map(({ name }) => name)
        .sort(compare);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new PersistenceError("Could not list recovery journals", {
        cause: error,
      });
    }
  }
}
