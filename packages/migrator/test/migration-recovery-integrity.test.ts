import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationRecoveryJournalEntry } from "@braid/core";
import { JsonExecutionStore, JsonRecoveryJournalStore } from "@braid/store";
import {
  cleanupMigrationRecovery,
  resumeMigration,
} from "../src/migration-recovery.js";
import { acquireExecutionLock } from "../src/execution-lock.js";
import { ScriptedTestExecutor } from "../src/executors/scripted-test-executor.js";
import { inspectMigrationRecovery } from "../src/recovery-inspector.js";
import { runMigration } from "../src/migration-orchestrator.js";
import { recoveryHash } from "../src/recovery-support.js";
import {
  candidateBranchForExecution,
  WorktreeManager,
} from "../src/worktree-manager.js";
import { durableExecutorStagingPath } from "../src/executor-staging.js";
import {
  applyValidExtraction,
  createMigrationFixture,
  git,
} from "../src/testing/notification-fixture.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface MainState {
  head: string;
  status: string;
  diff: string;
}

const captureMain = async (repositoryRoot: string): Promise<MainState> => ({
  head: await git(repositoryRoot, ["rev-parse", "HEAD"]),
  status: await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]),
  diff: await git(repositoryRoot, ["diff", "--binary", "HEAD", "--"]),
});

const executorResult = () => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  events: [],
});

const executionDirectory = (
  repositoryRoot: string,
  executionId: string,
): string =>
  path.join(repositoryRoot, ".braid", "executions", executionId, "recovery");

const createHarness = async (
  executionId: string,
  result: typeof executorResult = executorResult,
) => {
  const container = await mkdtemp(
    path.join(tmpdir(), "braid-recovery-integrity-"),
  );
  temporaryDirectories.push(container);
  const item = await createMigrationFixture(container);
  const executionStore = new JsonExecutionStore(item.repositoryRoot);
  const journalStore = new JsonRecoveryJournalStore(item.repositoryRoot);
  const manager = new WorktreeManager({
    repositoryRoot: item.repositoryRoot,
    executionRoot: item.executionRoot,
  });
  let launches = 0;
  const executor = new ScriptedTestExecutor(async (_plan, context) => {
    launches += 1;
    await applyValidExtraction(context.worktreePath);
    return result();
  });
  const now = () => new Date("2026-07-15T00:02:00.000Z");
  return {
    item,
    executionId,
    executionStore,
    journalStore,
    manager,
    executor,
    now,
    launches: () => launches,
  };
};

type Harness = Awaited<ReturnType<typeof createHarness>>;

const runUntil = async (
  context: Harness,
  checkpoint: string,
): Promise<void> => {
  await expect(
    runMigration({
      repositoryRoot: context.item.repositoryRoot,
      proposal: context.item.proposal,
      snapshot: context.item.snapshot,
      config: context.item.config,
      approval: context.item.proposal.id,
      executor: { kind: "scripted-test" },
      migrationExecutor: context.executor,
      executionId: context.executionId,
      executionStore: context.executionStore,
      recoveryJournalStore: context.journalStore,
      worktreeManager: context.manager,
      now: context.now,
      async onRecoveryCheckpoint(actual) {
        if (actual === checkpoint)
          throw new Error(`interrupt after ${checkpoint}`);
      },
    }),
  ).rejects.toThrow(`interrupt after ${checkpoint}`);
};

const inspect = async (context: Harness) =>
  inspectMigrationRecovery({
    repositoryRoot: context.item.repositoryRoot,
    executionRoot: context.item.executionRoot,
    executionId: context.executionId,
    journalStore: context.journalStore,
    executionStore: context.executionStore,
    worktreeManager: context.manager,
  });

const resume = async (context: Harness) =>
  resumeMigration({
    repositoryRoot: context.item.repositoryRoot,
    executionRoot: context.item.executionRoot,
    executionId: context.executionId,
    proposal: context.item.proposal,
    snapshot: context.item.snapshot,
    config: context.item.config,
    migrationExecutor: context.executor,
    journalStore: context.journalStore,
    executionStore: context.executionStore,
    worktreeManager: context.manager,
    now: context.now,
  });

const cleanup = async (context: Harness) =>
  cleanupMigrationRecovery({
    repositoryRoot: context.item.repositoryRoot,
    executionRoot: context.item.executionRoot,
    executionId: context.executionId,
    journalStore: context.journalStore,
    executionStore: context.executionStore,
    worktreeManager: context.manager,
    now: context.now,
  });

const createUnknownResource = async (context: Harness): Promise<string> => {
  const filePath = path.join(
    context.item.executionRoot,
    "unrelated-user-resource",
    "keep.txt",
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "not owned by Braid recovery\n");
  return filePath;
};

const expectUnknownResource = async (filePath: string): Promise<void> => {
  await expect(readFile(filePath, "utf8")).resolves.toBe(
    "not owned by Braid recovery\n",
  );
};

describe("durable migration recovery integrity and ownership", () => {
  it("classifies a modified staging repository as manual and never relaunches the executor", async () => {
    const context = await createHarness(
      "E-46000000-0000-4000-8000-000000000601",
    );
    await runUntil(context, "executor-finished");
    expect(context.launches()).toBe(1);
    const mainBefore = await captureMain(context.item.repositoryRoot);
    const unknown = await createUnknownResource(context);
    await writeFile(
      path.join(
        durableExecutorStagingPath(
          context.item.executionRoot,
          context.executionId,
        ),
        "repository",
        "src",
        "orders",
        "order-service.ts",
      ),
      "export const foreignStagingMutation = true;\n",
    );

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "manual-inspection-required",
      latestCheckpoint: "executor-finished",
      executorLaunchPermitted: false,
      candidateCreationPermitted: false,
      cleanupEligible: false,
    });
    await expect(resume(context)).rejects.toMatchObject({ exitCode: 12 });
    await expect(cleanup(context)).rejects.toMatchObject({
      exitCode: 12,
      code: "recovery-cleanup-not-eligible",
    });
    expect(context.launches()).toBe(1);
    await expectUnknownResource(unknown);
    expect(await captureMain(context.item.repositoryRoot)).toEqual(mainBefore);
  }, 30_000);

  it("classifies patch artifact hash drift as unsafe and makes cleanup ineligible", async () => {
    const context = await createHarness(
      "E-47000000-0000-4000-8000-000000000701",
    );
    await runUntil(context, "patch-captured");
    const journal = await context.journalStore.loadJournal(context.executionId);
    const patchEntry = journal.entries.find(
      ({ checkpoint }) => checkpoint === "patch-captured",
    );
    if (patchEntry?.evidence.checkpoint !== "patch-captured")
      throw new Error("patch checkpoint was not persisted");
    const patchPath = path.resolve(
      context.item.repositoryRoot,
      patchEntry.evidence.patchResource.portableLocator,
    );
    await writeFile(
      patchPath,
      `${await readFile(patchPath, "utf8")}\n# drift\n`,
    );
    const unknown = await createUnknownResource(context);
    const mainBefore = await captureMain(context.item.repositoryRoot);

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "unsafe-to-resume",
      latestCheckpoint: "patch-captured",
      cleanupEligible: false,
      executorLaunchPermitted: false,
      candidateCreationPermitted: false,
    });
    await expect(resume(context)).rejects.toMatchObject({ exitCode: 12 });
    await expect(cleanup(context)).rejects.toMatchObject({
      exitCode: 12,
      code: "recovery-cleanup-not-eligible",
    });
    expect(context.launches()).toBe(1);
    await expectUnknownResource(unknown);
    expect(await captureMain(context.item.repositoryRoot)).toEqual(mainBefore);
  }, 30_000);

  it("binds the durable executor result to every executor-finished journal field", async () => {
    const context = await createHarness(
      "E-47500000-0000-4000-8000-000000000751",
      () => ({ ...executorResult(), exitCode: 7 }),
    );
    await runUntil(context, "executor-finished");
    const resultPath = path.join(
      executionDirectory(context.item.repositoryRoot, context.executionId),
      "executor-result.json",
    );
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      exitCode: number;
    };
    await writeFile(
      resultPath,
      `${JSON.stringify({ ...result, exitCode: 0 }, null, 2)}\n`,
    );
    const mainBefore = await captureMain(context.item.repositoryRoot);

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "unsafe-to-resume",
      latestCheckpoint: "executor-finished",
      integrity: {
        valid: false,
        code: "resource-integrity-mismatch",
      },
      cleanupEligible: false,
      executorLaunchPermitted: false,
      candidateCreationPermitted: false,
    });
    await expect(resume(context)).rejects.toMatchObject({ exitCode: 12 });
    expect(context.launches()).toBe(1);
    expect(
      await git(context.item.repositoryRoot, [
        "rev-parse",
        candidateBranchForExecution(context.executionId),
      ]),
    ).toBe(context.item.baseCommit);
    expect(await captureMain(context.item.repositoryRoot)).toEqual(mainBefore);
  }, 30_000);

  it("classifies a foreign candidate ref target as unsafe and preserves it for inspection", async () => {
    const context = await createHarness(
      "E-48000000-0000-4000-8000-000000000801",
    );
    await runUntil(context, "candidate-prepared");
    const foreignCommit = (
      await execFileAsync(
        "git",
        [
          "-C",
          context.item.repositoryRoot,
          "commit-tree",
          `${context.item.baseCommit}^{tree}`,
          "-p",
          context.item.baseCommit,
          "-m",
          "foreign candidate",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Foreign Owner",
            GIT_AUTHOR_EMAIL: "foreign@example.invalid",
            GIT_AUTHOR_DATE: "2026-07-15T00:03:00Z",
            GIT_COMMITTER_NAME: "Foreign Owner",
            GIT_COMMITTER_EMAIL: "foreign@example.invalid",
            GIT_COMMITTER_DATE: "2026-07-15T00:03:00Z",
          },
        },
      )
    ).stdout.trim();
    const candidateRef = `refs/heads/${candidateBranchForExecution(
      context.executionId,
    )}`;
    await git(context.item.repositoryRoot, [
      "update-ref",
      candidateRef,
      foreignCommit,
    ]);
    const unknown = await createUnknownResource(context);
    const mainBefore = await captureMain(context.item.repositoryRoot);

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "unsafe-to-resume",
      latestCheckpoint: "failed",
      cleanupEligible: false,
      executorLaunchPermitted: false,
      candidateCreationPermitted: false,
    });
    await expect(resume(context)).rejects.toMatchObject({ exitCode: 12 });
    await expect(cleanup(context)).rejects.toMatchObject({
      exitCode: 12,
      code: "recovery-cleanup-not-eligible",
    });
    expect(
      await git(context.item.repositoryRoot, ["rev-parse", candidateRef]),
    ).toBe(foreignCommit);
    expect(context.launches()).toBe(1);
    await expectUnknownResource(unknown);
    expect(await captureMain(context.item.repositoryRoot)).toEqual(mainBefore);
  }, 30_000);

  it("reclaims only a verified same-host stale lock", async () => {
    const context = await createHarness(
      "E-49000000-0000-4000-8000-000000000901",
    );
    await runUntil(context, "preflight-passed");
    const journal = await context.journalStore.loadJournal(context.executionId);
    const repositoryId = journal.entries[0]!.identity.repositoryId;
    const staleToken = randomUUID();
    const lockDirectory = path.join(
      executionDirectory(context.item.repositoryRoot, context.executionId),
      "mutation.lock",
    );
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          executionId: context.executionId,
          repositoryId,
          host: hostname(),
          pid: 2_147_483_647,
          token: staleToken,
          acquiredAt: "2026-07-15T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    const unknown = await createUnknownResource(context);
    const mainBefore = await captureMain(context.item.repositoryRoot);

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "resumable",
      lock: { status: "stale" },
    });
    const lock = await acquireExecutionLock({
      projectRoot: context.item.repositoryRoot,
      executionId: context.executionId,
      repositoryId,
      now: context.now,
    });
    expect(lock.owner).toMatchObject({ pid: process.pid, repositoryId });
    expect(lock.owner.token).not.toBe(staleToken);
    await lock.release();
    await expect(inspect(context)).resolves.toMatchObject({
      classification: "resumable",
      lock: { status: "unlocked" },
    });
    expect(context.launches()).toBe(0);
    await expectUnknownResource(unknown);
    expect(await captureMain(context.item.repositoryRoot)).toEqual(mainBefore);
  }, 30_000);

  it("rejects concurrent acquire, resume, and cleanup while a live lock exists", async () => {
    const context = await createHarness(
      "E-4a000000-0000-4000-8000-000000001001",
    );
    await runUntil(context, "preflight-passed");
    const journal = await context.journalStore.loadJournal(context.executionId);
    const repositoryId = journal.entries[0]!.identity.repositoryId;
    const lock = await acquireExecutionLock({
      projectRoot: context.item.repositoryRoot,
      executionId: context.executionId,
      repositoryId,
      now: context.now,
    });
    const unknown = await createUnknownResource(context);
    const mainBefore = await captureMain(context.item.repositoryRoot);
    try {
      await expect(
        acquireExecutionLock({
          projectRoot: context.item.repositoryRoot,
          executionId: context.executionId,
          repositoryId,
          now: context.now,
        }),
      ).rejects.toMatchObject({
        exitCode: 12,
        code: "recovery-lock-conflict",
      });
      await expect(inspect(context)).resolves.toMatchObject({
        classification: "unsafe-to-resume",
        lock: { status: "live" },
        cleanupEligible: false,
      });
      await expect(resume(context)).rejects.toMatchObject({ exitCode: 12 });
      await expect(cleanup(context)).rejects.toMatchObject({
        exitCode: 12,
        code: "recovery-cleanup-not-eligible",
      });
      expect(context.launches()).toBe(0);
      await expectUnknownResource(unknown);
      expect(await captureMain(context.item.repositoryRoot)).toEqual(
        mainBefore,
      );
    } finally {
      await lock.release();
    }
  }, 30_000);

  it("cleans its owned execution without removing an unrelated worktree or resource", async () => {
    const context = await createHarness(
      "E-4b000000-0000-4000-8000-000000001101",
    );
    const unrelatedWorktree = path.join(
      context.item.container,
      "unrelated-worktree",
    );
    const unrelatedBranch = "unrelated-recovery-integrity";
    await git(context.item.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      unrelatedBranch,
      unrelatedWorktree,
      context.item.baseCommit,
    ]);
    await runUntil(context, "executor-started");
    const unknown = await createUnknownResource(context);
    const mainBefore = await captureMain(context.item.repositoryRoot);

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "unsafe-to-resume",
      latestCheckpoint: "executor-started",
      cleanupEligible: true,
    });
    await expect(cleanup(context)).resolves.toMatchObject({
      latestCheckpoint: "discarded",
    });
    await expect(access(unrelatedWorktree)).resolves.toBeUndefined();
    expect(await git(unrelatedWorktree, ["rev-parse", "HEAD"])).toBe(
      context.item.baseCommit,
    );
    expect(
      await git(context.item.repositoryRoot, [
        "rev-parse",
        `refs/heads/${unrelatedBranch}`,
      ]),
    ).toBe(context.item.baseCommit);
    expect(
      await git(context.item.repositoryRoot, [
        "branch",
        "--list",
        candidateBranchForExecution(context.executionId),
      ]),
    ).toBe("");
    await expectUnknownResource(unknown);
    expect(context.launches()).toBe(0);
    expect(await captureMain(context.item.repositoryRoot)).toEqual(mainBefore);
  }, 30_000);

  it("reports a missing journal sequence as manual inspection without mutation", async () => {
    const context = await createHarness(
      "E-4c000000-0000-4000-8000-000000001201",
    );
    await runUntil(context, "preflight-passed");
    const entriesDirectory = path.join(
      executionDirectory(context.item.repositoryRoot, context.executionId),
      "entries",
    );
    const entries = (await readdir(entriesDirectory)).sort();
    expect(entries).toHaveLength(2);
    await rename(
      path.join(entriesDirectory, entries[1]!),
      path.join(entriesDirectory, entries[1]!.replace("000001", "000002")),
    );
    const unknown = await createUnknownResource(context);
    const mainBefore = await captureMain(context.item.repositoryRoot);

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "manual-inspection-required",
      integrity: { valid: false, code: "missing-sequence" },
      cleanupEligible: false,
      executorLaunchPermitted: false,
      candidateCreationPermitted: false,
    });
    await expect(resume(context)).rejects.toMatchObject({ exitCode: 12 });
    await expect(cleanup(context)).rejects.toMatchObject({ exitCode: 12 });
    expect(context.launches()).toBe(0);
    await expectUnknownResource(unknown);
    expect(await captureMain(context.item.repositoryRoot)).toEqual(mainBefore);
  }, 30_000);

  it("treats an intact planned journal with a non-exact approval identity as unsafe", async () => {
    const context = await createHarness(
      "E-4d000000-0000-4000-8000-000000001301",
    );
    await runUntil(context, "planned");
    const entriesDirectory = path.join(
      executionDirectory(context.item.repositoryRoot, context.executionId),
      "entries",
    );
    const [fileName] = await readdir(entriesDirectory);
    const entryPath = path.join(entriesDirectory, fileName!);
    const original = JSON.parse(
      await readFile(entryPath, "utf8"),
    ) as MigrationRecoveryJournalEntry;
    const identity = {
      ...original.identity,
      approvalHash: "0".repeat(64),
    };
    const semanticHash = recoveryHash({
      schemaVersion: original.schemaVersion,
      journalId: original.journalId,
      executionId: original.executionId,
      proposalId: original.proposalId,
      planId: original.planId,
      baseCommit: original.baseCommit,
      checkpoint: original.checkpoint,
      identity,
      evidence: original.evidence,
    });
    const updated = { ...original, identity, semanticHash };
    const { entryHash: _entryHash, ...entryContent } = updated;
    void _entryHash;
    await writeFile(
      entryPath,
      `${JSON.stringify(
        { ...updated, entryHash: recoveryHash(entryContent) },
        null,
        2,
      )}\n`,
    );
    await expect(
      context.journalStore.loadJournal(context.executionId),
    ).resolves.toMatchObject({ integrity: { valid: true } });
    const unknown = await createUnknownResource(context);
    const mainBefore = await captureMain(context.item.repositoryRoot);

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "unsafe-to-resume",
      latestCheckpoint: "planned",
      integrity: { valid: true },
      executorLaunchPermitted: false,
      candidateCreationPermitted: false,
      cleanupEligible: false,
    });
    await expect(resume(context)).rejects.toMatchObject({ exitCode: 12 });
    expect(context.launches()).toBe(0);
    await expectUnknownResource(unknown);
    expect(await captureMain(context.item.repositoryRoot)).toEqual(mainBefore);
  }, 30_000);
});
