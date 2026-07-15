import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MigrationExecutor } from "@braid/migrator";
import { JsonProposalStore, JsonSnapshotStore } from "@braid/store";
import {
  migrateDiffCommand,
  migrateDiscardCommand,
  migrateInspectCommand,
  migrateListCommand,
  migratePlanCommand,
  migrateRunCommand,
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

const fixture = async () => {
  const container = await mkdtemp(path.join(tmpdir(), "braid-cli-migrate-"));
  temporaryDirectories.push(container);
  const item = await createMigrationFixture(container);
  await new JsonSnapshotStore(item.repositoryRoot).save(item.snapshot);
  await new JsonProposalStore(item.repositoryRoot).save(item.proposal);
  return item;
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
});
