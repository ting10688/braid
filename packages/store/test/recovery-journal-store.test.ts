import { createHash } from "node:crypto";
import path from "node:path";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationRecoveryJournalEntry } from "@braid/core";
import {
  JsonRecoveryJournalStore,
  type RecoveryJournalEntryInput,
} from "../src/recovery-journal-store.js";

const temporaryDirectories: string[] = [];
const hash = "a".repeat(64);
const alternateHash = "b".repeat(64);
const baseCommit = "c".repeat(40);
const firstExecution = "E-00000000-0000-0000-0000-000000000001";
const secondExecution = "E-00000000-0000-0000-0000-000000000002";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-recovery-journal-"));
  temporaryDirectories.push(root);
  return root;
};

const identity = () => ({
  repositoryId: hash,
  gitCommonDirectoryId: hash,
  originatingWorktreeId: hash,
  configHash: hash,
  sourceFingerprint: hash,
  approvalHash: hash,
  planHash: hash,
  proposalHash: hash,
});

const planned = (executionId = firstExecution): RecoveryJournalEntryInput => ({
  schemaVersion: "1.0.0",
  journalId:
    executionId === firstExecution
      ? "RJ-0123456789abcdef"
      : "RJ-fedcba9876543210",
  executionId,
  proposalId: "P-EM-a18d42f3",
  planId: "PL-1234567890abcdef",
  baseCommit,
  checkpoint: "planned",
  identity: identity(),
  evidence: {
    checkpoint: "planned",
    executorInvocationId: hash,
    executorConfigHash: hash,
    createCommit: true,
    resources: [
      {
        resourceId: "journal",
        resourceType: "journal",
        executionId,
        repositoryId: hash,
        baseCommit,
        portableLocator: `.braid/executions/${executionId}/recovery`,
        creationCheckpoint: "planned",
        integrityHash: hash,
      },
    ],
  },
  recordedAt: "2026-07-16T00:00:00.000Z",
  diagnostics: [],
});

const preflightPassed = (): RecoveryJournalEntryInput => ({
  ...planned(),
  checkpoint: "preflight-passed",
  evidence: {
    checkpoint: "preflight-passed",
    freshnessHash: hash,
    preflightHash: hash,
  },
  recordedAt: "2026-07-16T00:01:00.000Z",
});

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
const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
const entryWithoutHash = (entry: MigrationRecoveryJournalEntry): unknown => {
  const { entryHash: _entryHash, ...content } = entry;
  void _entryHash;
  return content;
};

describe("JSON recovery journal store", () => {
  it("atomically appends hash-chained entries and replays identical checkpoints", async () => {
    const root = await temporaryRoot();
    const store = new JsonRecoveryJournalStore(root);
    const first = await store.appendEntry(planned());
    const replay = await store.appendEntry({
      ...planned(),
      recordedAt: "2026-07-16T01:00:00.000Z",
    });
    const second = await store.appendEntry(preflightPassed());

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ sequence: 0, previousEntryHash: null });
    expect(second).toMatchObject({
      sequence: 1,
      previousEntryHash: first.entryHash,
    });
    await expect(store.loadJournal(firstExecution)).resolves.toEqual({
      entries: [first, second],
      integrity: { valid: true, temporaryFiles: [] },
    });
    expect(
      await readdir(
        path.join(
          root,
          ".braid",
          "executions",
          firstExecution,
          "recovery",
          "entries",
        ),
      ),
    ).toEqual(["000000-planned.json", "000001-preflight-passed.json"]);
  });

  it("rejects conflicting replay and illegal transitions without rewriting evidence", async () => {
    const root = await temporaryRoot();
    const store = new JsonRecoveryJournalStore(root);
    await expect(store.appendEntry(preflightPassed())).rejects.toThrow(
      /empty -> preflight-passed/u,
    );
    const first = await store.appendEntry(planned());
    await expect(
      store.appendEntry({
        ...planned(),
        evidence: {
          checkpoint: "planned",
          executorInvocationId: alternateHash,
          executorConfigHash: hash,
          createCommit: true,
          resources: planned().evidence.resources,
        },
      }),
    ).rejects.toThrow(/different content/u);
    expect((await store.loadJournal(firstExecution)).entries).toEqual([first]);
  });

  it("detects tampering and refuses further appends", async () => {
    const root = await temporaryRoot();
    const store = new JsonRecoveryJournalStore(root);
    await store.appendEntry(planned());
    const destination = path.join(
      root,
      ".braid",
      "executions",
      firstExecution,
      "recovery",
      "entries",
      "000000-planned.json",
    );
    const persisted = JSON.parse(await readFile(destination, "utf8")) as {
      recordedAt: string;
    };
    persisted.recordedAt = "2026-07-16T02:00:00.000Z";
    await writeFile(destination, `${JSON.stringify(persisted, null, 2)}\n`);

    const journal = await store.loadJournal(firstExecution);
    expect(journal.integrity).toMatchObject({
      valid: false,
      code: "entry-hash-mismatch",
    });
    await expect(store.appendEntry(preflightPassed())).rejects.toThrow(
      /invalid recovery journal/u,
    );
  });

  it("detects missing entry sequences", async () => {
    const root = await temporaryRoot();
    const store = new JsonRecoveryJournalStore(root);
    await store.appendEntry(planned());
    await store.appendEntry(preflightPassed());
    const directory = path.join(
      root,
      ".braid",
      "executions",
      firstExecution,
      "recovery",
      "entries",
    );
    await rename(
      path.join(directory, "000001-preflight-passed.json"),
      path.join(directory, "000002-preflight-passed.json"),
    );

    expect((await store.loadJournal(firstExecution)).integrity).toMatchObject({
      valid: false,
      code: "missing-sequence",
    });
  });

  it("ignores incomplete temporary files and reports portable diagnostics", async () => {
    const root = await temporaryRoot();
    const store = new JsonRecoveryJournalStore(root);
    const first = await store.appendEntry(planned());
    const directory = path.join(
      root,
      ".braid",
      "executions",
      firstExecution,
      "recovery",
      "entries",
    );
    await writeFile(path.join(directory, ".partial.tmp"), "incomplete");

    await expect(store.loadJournal(firstExecution)).resolves.toEqual({
      entries: [first],
      integrity: { valid: true, temporaryFiles: [".partial.tmp"] },
    });
  });

  it("detects a structurally valid duplicate checkpoint", async () => {
    const root = await temporaryRoot();
    const store = new JsonRecoveryJournalStore(root);
    await store.appendEntry(planned());
    const preflight = await store.appendEntry(preflightPassed());
    const unsigned = {
      ...preflight,
      sequence: 2,
      previousEntryHash: preflight.entryHash,
      recordedAt: "2026-07-16T00:02:00.000Z",
    };
    const duplicate = {
      ...unsigned,
      entryHash: sha256(entryWithoutHash(unsigned)),
    };
    const destination = path.join(
      root,
      ".braid",
      "executions",
      firstExecution,
      "recovery",
      "entries",
      "000002-preflight-passed.json",
    );
    await writeFile(destination, `${JSON.stringify(duplicate, null, 2)}\n`);

    expect((await store.loadJournal(firstExecution)).integrity).toMatchObject({
      valid: false,
      code: "conflicting-checkpoint",
    });
  });

  it("uses deterministic hashes, filenames, and execution ordering", async () => {
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();
    const firstStore = new JsonRecoveryJournalStore(firstRoot);
    const secondStore = new JsonRecoveryJournalStore(secondRoot);
    const orderedIdentity = identity();
    const reversedIdentity = Object.fromEntries(
      Object.entries(orderedIdentity).reverse(),
    ) as typeof orderedIdentity;
    const first = await firstStore.appendEntry(planned());
    const repeated = await secondStore.appendEntry({
      ...planned(),
      identity: reversedIdentity,
    });
    await firstStore.appendEntry(planned(secondExecution));

    expect(repeated.semanticHash).toBe(first.semanticHash);
    expect(repeated.entryHash).toBe(first.entryHash);
    await expect(firstStore.listExecutionIds()).resolves.toEqual([
      firstExecution,
      secondExecution,
    ]);
  });
});
