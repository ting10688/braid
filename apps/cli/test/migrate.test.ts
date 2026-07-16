import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrationProposalSchema } from "@braid/core";
import type { MigrationExecutor } from "@braid/migrator";
import {
  JsonExecutionStore,
  JsonProposalStore,
  JsonSnapshotStore,
} from "@braid/store";
import {
  migrateDiffCommand,
  migrateDiscardCommand,
  migrateInspectCommand,
  migrateListCommand,
  migratePlanCommand,
  migrateRunCommand,
  migrateSuggestCommand,
  migrateStatusCommand,
} from "../src/commands/migrate.js";
import {
  applyValidExtraction,
  createMigrationFixture,
  git,
} from "../../../packages/migrator/src/testing/notification-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const captureStdout = () => {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  });
  return () => output;
};

const fixture = async (complete = true) => {
  const container = await mkdtemp(path.join(tmpdir(), "braid-cli-migrate-"));
  temporaryDirectories.push(container);
  const item = await createMigrationFixture(container);
  const proposal = complete
    ? item.proposal
    : migrationProposalSchema.parse({
        ...item.proposal,
        target: {
          ...item.proposal.target,
          approvedCompanionSymbols: undefined,
        },
      });
  await new JsonSnapshotStore(item.repositoryRoot).save(item.snapshot);
  await new JsonProposalStore(item.repositoryRoot).save(proposal);
  return { ...item, proposal };
};

const controlledCodex = (): MigrationExecutor => ({
  kind: "codex",
  inspect: async () => ({
    kind: "codex",
    executableVersion: "codex-cli controlled-test",
    sandbox: "workspace-write",
  }),
  execute: async (_plan, context) => {
    await applyValidExtraction(context.worktreePath);
    return {
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      events: [],
      summary: {
        status: "completed",
        changedFiles: ["src/orders/order-service.ts"],
        addedFiles: ["src/notification/notification-service.ts"],
        testsRun: [],
        summary: "Controlled CLI migration.",
        unresolvedConcerns: [],
      },
    };
  },
});

describe("migrate CLI commands", () => {
  it("plans, runs, lists, inspects, diffs, reports, and safely discards", async () => {
    const item = await fixture();
    const executionId = "E-90000000-0000-4000-8000-000000000011";
    const output = captureStdout();

    await migratePlanCommand(item.proposal.id, {
      path: item.repositoryRoot,
      json: true,
    });
    expect(output()).toContain('"planId": "PL-');
    await migratePlanCommand(item.proposal.id, {
      path: item.repositoryRoot,
    });
    expect(output()).toContain("Readiness: ready");
    expect(output()).toContain(
      "Required companions: src/orders/order-service.ts#SentNotification",
    );

    await migrateRunCommand(
      item.proposal.id,
      {
        path: item.repositoryRoot,
        approve: item.proposal.id,
        executor: "codex",
        timeout: "120000",
        json: true,
      },
      {
        executorFactory: controlledCodex,
        executionIdFactory: () => executionId,
      },
    );
    expect(output()).toContain('"status": "succeeded"');

    await migrateListCommand({ path: item.repositoryRoot, json: true });
    await migrateStatusCommand(executionId, {
      path: item.repositoryRoot,
      json: true,
    });
    await migrateInspectCommand(executionId, { path: item.repositoryRoot });
    await migrateDiffCommand(executionId, { path: item.repositoryRoot });
    expect(output()).toContain(executionId);
    expect(output()).toContain("diff --git");

    await expect(
      migrateDiscardCommand(executionId, {
        path: item.repositoryRoot,
        confirm: "wrong",
      }),
    ).rejects.toMatchObject({ exitCode: 12 });
    await migrateDiscardCommand(executionId, {
      path: item.repositoryRoot,
      confirm: executionId,
      json: true,
    });
    await expect(
      migrateDiscardCommand(executionId, {
        path: item.repositoryRoot,
        confirm: executionId,
        json: true,
      }),
    ).resolves.toBeUndefined();
    expect(output()).toContain('"status": "discarded"');
    expect(
      await git(item.repositoryRoot, ["branch", "--list", "braid/exec/*"]),
    ).toBe("");
    expect(await git(item.repositoryRoot, ["remote", "-v"])).toBe("");
  }, 15_000);

  it("maps invalid production options and missing approval to stable exit codes", async () => {
    const item = await fixture();
    await expect(
      migrateRunCommand(item.proposal.id, {
        path: item.repositoryRoot,
        executor: "scripted-test",
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      migrateRunCommand(
        item.proposal.id,
        { path: item.repositoryRoot },
        {
          executorFactory: controlledCodex,
          executionIdFactory: () => "E-a0000000-0000-4000-8000-000000000012",
        },
      ),
    ).rejects.toMatchObject({ exitCode: 3, code: "approval-mismatch" });
    await expect(
      migrateRunCommand(item.proposal.id, {
        path: item.repositoryRoot,
        approve: item.proposal.id,
        timeout: "999",
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      migratePlanCommand("not-a-proposal", { path: item.repositoryRoot }),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      migratePlanCommand("P-EM-deadbeef", { path: item.repositoryRoot }),
    ).rejects.toMatchObject({ exitCode: 4, code: "stale-proposal" });
  });

  it("shows and rejects not-ready proposals before executor launch", async () => {
    const item = await fixture(false);
    const output = captureStdout();
    let launches = 0;
    const executor: MigrationExecutor = {
      kind: "codex",
      inspect: async () => ({ kind: "codex", sandbox: "workspace-write" }),
      execute: async () => {
        launches += 1;
        throw new Error("not-ready proposal launched the executor");
      },
    };

    await migratePlanCommand(item.proposal.id, {
      path: item.repositoryRoot,
    });
    expect(output()).toContain("Readiness: not-ready");
    expect(output()).toContain("companion-not-authorized");

    await expect(
      migrateRunCommand(
        item.proposal.id,
        {
          path: item.repositoryRoot,
          approve: item.proposal.id,
        },
        {
          executorFactory: () => executor,
          executionIdFactory: () => "E-a1000000-0000-4000-8000-000000000032",
        },
      ),
    ).rejects.toMatchObject({ exitCode: 13, code: "execution-not-ready" });
    expect(launches).toBe(0);
    expect(
      await git(item.repositoryRoot, ["branch", "--list", "braid/exec/*"]),
    ).toBe("");
  });

  it("suggests an advisory repair without mutating stores or Git state", async () => {
    const item = await fixture(false);
    const proposalStore = new JsonProposalStore(item.repositoryRoot);
    const snapshotStore = new JsonSnapshotStore(item.repositoryRoot);
    const beforeProposal = await proposalStore.load(item.proposal.id);
    const beforeSnapshot = await snapshotStore.load(item.snapshot.id);
    const beforeHead = await git(item.repositoryRoot, ["rev-parse", "HEAD"]);
    const beforeWorktrees = await git(item.repositoryRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const output = captureStdout();

    await migrateSuggestCommand(item.proposal.id, {
      path: item.repositoryRoot,
      json: true,
    });
    const suggestion = JSON.parse(output());
    expect(suggestion).toMatchObject({
      baseProposalId: item.proposal.id,
      state: "actionable",
      currentReadinessState: "not-ready",
      predictedReadinessState: "ready",
      minimal: true,
      advisory: true,
    });
    expect(suggestion.suggestedCompanionSymbolAdditions).toHaveLength(1);
    expect(
      suggestion.suggestedCompanionSymbolAdditions[0].symbol,
    ).toMatchObject({
      file: "src/orders/order-service.ts",
      name: "SentNotification",
    });

    vi.restoreAllMocks();
    const humanOutput = captureStdout();
    await migrateSuggestCommand(item.proposal.id, {
      path: item.repositoryRoot,
    });
    expect(humanOutput()).toContain("Suggestion: actionable");
    expect(humanOutput()).toContain(
      "- src/orders/order-service.ts#SentNotification",
    );
    expect(humanOutput()).toContain("No proposal was modified or approved.");
    expect(humanOutput()).toContain(
      "Create or approve a revised proposal before execution.",
    );

    await migratePlanCommand(item.proposal.id, {
      path: item.repositoryRoot,
    });
    expect(humanOutput()).toContain("Repair suggestion: actionable");
    expect(humanOutput()).toContain("Predicted readiness: ready");

    expect(await proposalStore.load(item.proposal.id)).toEqual(beforeProposal);
    expect(await snapshotStore.load(item.snapshot.id)).toEqual(beforeSnapshot);
    expect(
      await new JsonExecutionStore(item.repositoryRoot).listRecords(),
    ).toEqual([]);
    expect(await git(item.repositoryRoot, ["rev-parse", "HEAD"])).toBe(
      beforeHead,
    );
    expect(
      await git(item.repositoryRoot, ["worktree", "list", "--porcelain"]),
    ).toBe(beforeWorktrees);
    expect(
      await git(item.repositoryRoot, ["branch", "--list", "braid/exec/*"]),
    ).toBe("");

    let launches = 0;
    await expect(
      migrateRunCommand(
        item.proposal.id,
        {
          path: item.repositoryRoot,
          approve: item.proposal.id,
        },
        {
          executorFactory: () => ({
            kind: "codex",
            inspect: async () => ({
              kind: "codex",
              sandbox: "workspace-write",
            }),
            execute: async () => {
              launches += 1;
              throw new Error("suggestion made original proposal executable");
            },
          }),
          executionIdFactory: () => "E-a2000000-0000-4000-8000-000000000033",
        },
      ),
    ).rejects.toMatchObject({ exitCode: 13, code: "execution-not-ready" });
    expect(launches).toBe(0);
  });
});
