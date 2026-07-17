import path from "node:path";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JsonExecutionStore, JsonRecoveryJournalStore } from "@braid/store";
import {
  cleanupMigrationRecovery,
  resumeMigration,
} from "../src/migration-recovery.js";
import { acquireExecutionLock } from "../src/execution-lock.js";
import { ScriptedTestExecutor } from "../src/executors/scripted-test-executor.js";
import { inspectMigrationRecovery } from "../src/recovery-inspector.js";
import { runMigration } from "../src/migration-orchestrator.js";
import {
  candidateBranchForExecution,
  WorktreeManager,
} from "../src/worktree-manager.js";
import {
  applyValidExtraction,
  createMigrationFixture,
  git,
  type MigrationFixture,
} from "../src/testing/notification-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixture = async (): Promise<MigrationFixture> => {
  const container = await mkdtemp(path.join(tmpdir(), "braid-recovery-"));
  temporaryDirectories.push(container);
  return createMigrationFixture(container);
};

const executorResult = () => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  events: [],
});

const harness = async (executionId: string) => {
  const item = await fixture();
  const executionStore = new JsonExecutionStore(item.repositoryRoot);
  const journalStore = new JsonRecoveryJournalStore(item.repositoryRoot);
  const manager = new WorktreeManager({
    repositoryRoot: item.repositoryRoot,
    executionRoot: item.executionRoot,
  });
  let executorLaunches = 0;
  const executor = new ScriptedTestExecutor(async (_plan, context) => {
    executorLaunches += 1;
    await applyValidExtraction(context.worktreePath);
    return executorResult();
  });
  const shared = {
    repositoryRoot: item.repositoryRoot,
    proposal: item.proposal,
    snapshot: item.snapshot,
    config: item.config,
    migrationExecutor: executor,
    executionId,
    executionStore,
    recoveryJournalStore: journalStore,
    worktreeManager: manager,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
  };
  return {
    item,
    executionStore,
    journalStore,
    manager,
    executor,
    shared,
    executorLaunches: () => executorLaunches,
  };
};

const interruptAfter =
  (target: string) =>
  async (checkpoint: string): Promise<void> => {
    if (checkpoint === target)
      throw new Error(`simulated interruption after ${target}`);
  };

const executeUntil = async (
  context: Awaited<ReturnType<typeof harness>>,
  checkpoint: string,
): Promise<void> => {
  await expect(
    runMigration({
      ...context.shared,
      approval: context.item.proposal.id,
      executor: { kind: "scripted-test" },
      onRecoveryCheckpoint: interruptAfter(checkpoint),
    }),
  ).rejects.toThrow(`simulated interruption after ${checkpoint}`);
};

const inspect = async (context: Awaited<ReturnType<typeof harness>>) =>
  inspectMigrationRecovery({
    repositoryRoot: context.item.repositoryRoot,
    executionRoot: context.item.executionRoot,
    executionId: context.shared.executionId,
    journalStore: context.journalStore,
    executionStore: context.executionStore,
    worktreeManager: context.manager,
  });

const resume = async (context: Awaited<ReturnType<typeof harness>>) =>
  resumeMigration({
    repositoryRoot: context.item.repositoryRoot,
    executionRoot: context.item.executionRoot,
    executionId: context.shared.executionId,
    proposal: context.item.proposal,
    snapshot: context.item.snapshot,
    config: context.item.config,
    migrationExecutor: context.executor,
    journalStore: context.journalStore,
    executionStore: context.executionStore,
    worktreeManager: context.manager,
    now: context.shared.now,
  });

describe("durable migration recovery", () => {
  it.each([
    ["preflight-passed", 0],
    ["executor-finished", 1],
    ["patch-captured", 1],
    ["architecture-passed", 1],
  ])(
    "resumes deterministically from %s without relaunching completed executor work",
    async (checkpoint, launchesBeforeResume) => {
      const suffix = {
        "preflight-passed": "101",
        "executor-finished": "102",
        "patch-captured": "103",
        "architecture-passed": "104",
      }[checkpoint]!;
      const context = await harness(
        `E-41000000-0000-4000-8000-000000000${suffix}`,
      );
      await executeUntil(context, checkpoint);

      expect(context.executorLaunches()).toBe(launchesBeforeResume);
      await expect(inspect(context)).resolves.toMatchObject({
        classification: "resumable",
        latestCheckpoint: checkpoint,
        integrity: { valid: true },
      });

      const result = await resume(context);
      expect(result.record).toMatchObject({
        status: "succeeded",
        candidateBranch: candidateBranchForExecution(
          context.shared.executionId,
        ),
      });
      expect(result.record.candidateCommit).toMatch(/^[a-f0-9]{40}$/u);
      expect(context.executorLaunches()).toBe(1);
      await expect(inspect(context)).resolves.toMatchObject({
        classification: "already-complete",
        latestCheckpoint: "completed",
        integrity: { valid: true },
      });
      expect(
        await git(context.item.repositoryRoot, ["status", "--porcelain=v1"]),
      ).toBe("");
    },
    30_000,
  );

  it("treats a completed execution as an idempotent zero-mutation resume", async () => {
    const context = await harness("E-42000000-0000-4000-8000-000000000201");
    const first = await runMigration({
      ...context.shared,
      approval: context.item.proposal.id,
      executor: { kind: "scripted-test" },
    });
    const beforeJournal = await context.journalStore.loadJournal(
      context.shared.executionId,
    );
    const beforeStatus = await git(context.item.repositoryRoot, [
      "status",
      "--porcelain=v1",
    ]);
    const beforeRef = await git(context.item.repositoryRoot, [
      "rev-parse",
      `refs/heads/${candidateBranchForExecution(context.shared.executionId)}`,
    ]);

    const result = await resume(context);
    const afterJournal = await context.journalStore.loadJournal(
      context.shared.executionId,
    );

    expect(result.record).toEqual(first.record);
    expect(context.executorLaunches()).toBe(1);
    expect(afterJournal.entries).toEqual(beforeJournal.entries);
    expect(
      await git(context.item.repositoryRoot, ["status", "--porcelain=v1"]),
    ).toBe(beforeStatus);
    expect(
      await git(context.item.repositoryRoot, [
        "rev-parse",
        `refs/heads/${candidateBranchForExecution(context.shared.executionId)}`,
      ]),
    ).toBe(beforeRef);
  }, 30_000);

  it("classifies a live execution lock as unsafe and journal tampering as manual inspection", async () => {
    const context = await harness("E-43000000-0000-4000-8000-000000000301");
    await executeUntil(context, "preflight-passed");
    const journal = await context.journalStore.loadJournal(
      context.shared.executionId,
    );
    const repositoryId = journal.entries[0]!.identity.repositoryId;
    const lock = await acquireExecutionLock({
      projectRoot: context.item.repositoryRoot,
      executionId: context.shared.executionId,
      repositoryId,
      now: context.shared.now,
    });
    try {
      await expect(inspect(context)).resolves.toMatchObject({
        classification: "unsafe-to-resume",
        lock: { status: "live" },
      });
    } finally {
      await lock.release();
    }
    await expect(inspect(context)).resolves.toMatchObject({
      classification: "resumable",
      lock: { status: "unlocked" },
    });

    const entriesDirectory = path.join(
      context.item.repositoryRoot,
      ".braid",
      "executions",
      context.shared.executionId,
      "recovery",
      "entries",
    );
    const [firstEntry] = (await readdir(entriesDirectory)).sort();
    const entryPath = path.join(entriesDirectory, firstEntry!);
    const entry = JSON.parse(await readFile(entryPath, "utf8")) as {
      semanticHash: string;
    };
    await writeFile(
      entryPath,
      `${JSON.stringify({ ...entry, semanticHash: "0".repeat(64) }, null, 2)}\n`,
    );

    const report = await inspect(context);
    expect(report).toMatchObject({
      classification: "manual-inspection-required",
      integrity: { valid: false },
      executorLaunchPermitted: false,
      candidateCreationPermitted: false,
      cleanupEligible: false,
    });
    await expect(resume(context)).rejects.toMatchObject({
      exitCode: 12,
      code: "recovery-journal-integrity-failed",
    });
  }, 30_000);

  it("cleans only conclusively owned resources after an executor-started interruption", async () => {
    const context = await harness("E-44000000-0000-4000-8000-000000000401");
    await executeUntil(context, "executor-started");
    const before = await inspect(context);
    expect(before).toMatchObject({
      classification: "unsafe-to-resume",
      latestCheckpoint: "executor-started",
      cleanupEligible: true,
    });
    expect(context.executorLaunches()).toBe(0);

    const report = await cleanupMigrationRecovery({
      repositoryRoot: context.item.repositoryRoot,
      executionRoot: context.item.executionRoot,
      executionId: context.shared.executionId,
      journalStore: context.journalStore,
      executionStore: context.executionStore,
      worktreeManager: context.manager,
      now: context.shared.now,
    });
    expect(report).toMatchObject({
      latestCheckpoint: "discarded",
      cleanupEligible: false,
    });
    await expect(
      access(
        path.join(
          context.item.repositoryRoot,
          ".braid",
          "executions",
          context.shared.executionId,
          "recovery",
          "executor-process.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(context.item.executionRoot, context.shared.executionId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await git(context.item.repositoryRoot, [
        "branch",
        "--list",
        "braid/exec/*",
      ]),
    ).toBe("");
    expect(
      await git(context.item.repositoryRoot, ["status", "--porcelain=v1"]),
    ).toBe("");
  }, 30_000);

  it("refuses cleanup when a durable ownership marker was altered", async () => {
    const context = await harness("E-45000000-0000-4000-8000-000000000501");
    await executeUntil(context, "executor-started");
    const processMarker = path.join(
      context.item.repositoryRoot,
      ".braid",
      "executions",
      context.shared.executionId,
      "recovery",
      "executor-process.json",
    );
    await writeFile(processMarker, '{"tampered":true}\n');

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "manual-inspection-required",
      cleanupEligible: false,
      integrity: {
        valid: false,
        code: "resource-ownership-ambiguous",
      },
    });
    await expect(
      cleanupMigrationRecovery({
        repositoryRoot: context.item.repositoryRoot,
        executionRoot: context.item.executionRoot,
        executionId: context.shared.executionId,
        journalStore: context.journalStore,
        executionStore: context.executionStore,
        worktreeManager: context.manager,
        now: context.shared.now,
      }),
    ).rejects.toMatchObject({
      exitCode: 12,
      code: "recovery-cleanup-not-eligible",
    });
    await expect(access(processMarker)).resolves.toBeUndefined();
    await expect(
      access(path.join(context.item.executionRoot, context.shared.executionId)),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("does not accept a modified completed no-commit candidate as complete", async () => {
    const context = await harness("E-46000000-0000-4000-8000-000000000601");
    await runMigration({
      ...context.shared,
      approval: context.item.proposal.id,
      executor: { kind: "scripted-test" },
      createCommit: false,
    });
    await expect(inspect(context)).resolves.toMatchObject({
      classification: "already-complete",
      latestCheckpoint: "completed",
    });

    const owned = await context.manager.load(context.shared.executionId);
    const orderService = path.join(
      owned.worktreePath,
      "src/orders/order-service.ts",
    );
    await writeFile(
      orderService,
      `${await readFile(orderService, "utf8")}\n// external drift\n`,
    );

    await expect(inspect(context)).resolves.toMatchObject({
      classification: "unsafe-to-resume",
      latestCheckpoint: "completed",
      integrity: {
        valid: false,
        code: "resource-integrity-mismatch",
      },
      cleanupEligible: false,
    });
    expect(
      await git(context.item.repositoryRoot, ["status", "--porcelain=v1"]),
    ).toBe("");
  }, 30_000);
});
