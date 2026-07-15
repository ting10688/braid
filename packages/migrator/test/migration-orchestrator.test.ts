import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JsonExecutionStore } from "@braid/store";
import { ScriptedTestExecutor } from "../src/executors/scripted-test-executor.js";
import {
  createExecutionId,
  prepareMigrationPlan,
  runMigration,
} from "../src/migration-orchestrator.js";
import { captureMainCheckoutState } from "../src/main-integrity.js";
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

const fixture = async (
  options: {
    failingValidation?: boolean;
    committingValidation?: boolean;
  } = {},
): Promise<MigrationFixture> => {
  const container = await mkdtemp(path.join(tmpdir(), "braid-orchestrator-"));
  temporaryDirectories.push(container);
  return createMigrationFixture(container, options);
};

const executorResult = (
  overrides: {
    exitCode?: number | null;
    timedOut?: boolean;
  } = {},
) => ({
  exitCode: overrides.exitCode ?? 0,
  timedOut: overrides.timedOut ?? false,
  stdout: "",
  stderr: "",
  events: [],
});

const runInput = (
  item: MigrationFixture,
  executionId: string,
  executor: ScriptedTestExecutor,
) => ({
  repositoryRoot: item.repositoryRoot,
  proposal: item.proposal,
  snapshot: item.snapshot,
  config: item.config,
  approval: item.proposal.id,
  executor: { kind: "scripted-test" as const },
  migrationExecutor: executor,
  executionId,
  executionStore: new JsonExecutionStore(item.repositoryRoot),
  worktreeManager: new WorktreeManager({
    repositoryRoot: item.repositoryRoot,
    executionRoot: item.executionRoot,
  }),
  now: () => new Date("2026-07-15T00:01:00.000Z"),
});

describe("migration orchestrator", () => {
  it("runs the full scripted path, proves isolation, and creates one candidate commit", async () => {
    const item = await fixture();
    const executionId = "E-10000000-0000-4000-8000-000000000001";
    const manager = new WorktreeManager({
      repositoryRoot: item.repositoryRoot,
      executionRoot: item.executionRoot,
    });
    const store = new JsonExecutionStore(item.repositoryRoot);
    const mainIntegrityOptions = {
      ownedCandidateRef: `refs/heads/${candidateBranchForExecution(executionId)}`,
    } as const;
    const mainBefore = await captureMainCheckoutState(
      item.repositoryRoot,
      mainIntegrityOptions,
    );
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await applyValidExtraction(context.worktreePath);
      return executorResult();
    });
    const input = {
      ...runInput(item, executionId, executor),
      executionStore: store,
      worktreeManager: manager,
    };
    const firstPlan = await prepareMigrationPlan(input);
    const secondPlan = await prepareMigrationPlan(input);

    expect(secondPlan.planId).toBe(firstPlan.planId);
    const result = await runMigration(input);
    const owned = await manager.load(executionId);
    const mainAfter = await captureMainCheckoutState(item.repositoryRoot, {
      ...mainIntegrityOptions,
      ownedWorktreeGitDirectory: await manager.gitDirectory(executionId),
    });

    expect(result.record).toMatchObject({
      status: "succeeded",
      candidateBranch: "braid/exec/10000000",
      scope: { violations: [] },
      architecture: {
        actualImpact: {
          selectedSymbolsMoved: true,
          newCycles: 0,
          publicApiChanged: false,
          intendedOutcomeAchieved: true,
        },
      },
    });
    expect(result.record.candidateCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(
      result.record.validation.every(({ status }) => status === "passed"),
    ).toBe(true);
    expect(result.record.fingerprints.mainAfter).toBe(
      result.record.fingerprints.mainBefore,
    );
    expect(mainAfter).toEqual(mainBefore);
    expect(await git(item.repositoryRoot, ["status", "--porcelain=v1"])).toBe(
      "",
    );
    expect(await git(owned.worktreePath, ["status", "--porcelain=v1"])).toBe(
      "",
    );
    expect(
      await git(owned.worktreePath, ["rev-list", "--count", "HEAD^..HEAD"]),
    ).toBe("1");
    expect(await git(item.repositoryRoot, ["remote", "-v"])).toBe("");
    const message = await git(owned.worktreePath, [
      "show",
      "-s",
      "--format=%B",
    ]);
    expect(message).toContain(`Braid-Execution: ${executionId}`);
    expect(result.record.artifacts.patch).toContain("candidate.patch");
    expect(
      (await store.listRecords()).map(({ executionId: id }) => id),
    ).toEqual([executionId]);
    const portableRecord = await readFile(
      path.join(
        item.repositoryRoot,
        ".braid",
        "executions",
        executionId,
        "record.json",
      ),
      "utf8",
    );
    expect(portableRecord).not.toContain(item.container);
  }, 15_000);

  it("records and safely discards a candidate when ownership finalization fails", async () => {
    const item = await fixture();
    const executionId = "E-11000000-0000-4000-8000-000000000016";
    const store = new JsonExecutionStore(item.repositoryRoot);
    class InterruptedManager extends WorktreeManager {
      override async recordCandidateCommit(): Promise<void> {
        throw new Error("simulated locator interruption");
      }
    }
    const manager = new InterruptedManager({
      repositoryRoot: item.repositoryRoot,
      executionRoot: item.executionRoot,
    });
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await applyValidExtraction(context.worktreePath);
      return executorResult();
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
        worktreeManager: manager,
      }),
    ).rejects.toMatchObject({
      exitCode: 8,
      code: "candidate-commit-failed",
    });
    const record = await store.loadRecord(executionId);
    expect(record.status).toBe("scope-violation");
    expect(record.candidateCommit).toMatch(/^[a-f0-9]{40}$/u);

    await expect(manager.discard(executionId)).resolves.toBeUndefined();
    expect(
      await git(item.repositoryRoot, ["branch", "--list", "braid/exec/*"]),
    ).toBe("");
  }, 15_000);

  it("requires exact approval and records the rejected attempt without a worktree", async () => {
    const item = await fixture();
    const executionId = "E-20000000-0000-4000-8000-000000000002";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(() => executorResult());
    const input = {
      ...runInput(item, executionId, executor),
      approval: "true",
      executionStore: store,
    };

    await expect(runMigration(input)).rejects.toMatchObject({
      exitCode: 3,
      code: "approval-mismatch",
    });
    await expect(store.loadRecord(executionId)).resolves.toMatchObject({
      status: "preflight-failed",
      failure: { code: "approval-mismatch" },
    });
    expect(
      await git(item.repositoryRoot, ["branch", "--list", "braid/exec/*"]),
    ).toBe("");
  });

  it("records a preflight failure for a legacy snapshot without a fingerprint", async () => {
    const item = await fixture();
    const executionId = "E-21000000-0000-4000-8000-000000000015";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(() => executorResult());
    const { sourceFingerprint: _sourceFingerprint, ...legacySnapshot } =
      item.snapshot;
    void _sourceFingerprint;

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        snapshot: legacySnapshot,
        executionStore: store,
      }),
    ).rejects.toMatchObject({ exitCode: 4, code: "fingerprint-missing" });
    await expect(store.loadRecord(executionId)).resolves.toMatchObject({
      status: "preflight-failed",
      failure: { code: "fingerprint-missing" },
    });
  });

  it("rejects unauthorized and dependency changes before validation or commit", async () => {
    for (const unsafe of ["README.md", "package-lock.json"] as const) {
      const item = await fixture();
      const executionId =
        unsafe === "README.md"
          ? "E-30000000-0000-4000-8000-000000000003"
          : "E-30000000-0000-4000-8000-000000000004";
      const store = new JsonExecutionStore(item.repositoryRoot);
      const executor = new ScriptedTestExecutor(async (_plan, context) => {
        await writeFile(path.join(context.worktreePath, unsafe), "unsafe\n");
        return executorResult();
      });

      await expect(
        runMigration({
          ...runInput(item, executionId, executor),
          executionStore: store,
        }),
      ).rejects.toMatchObject({ exitCode: 8 });
      const record = await store.loadRecord(executionId);
      expect(record.status).toBe("scope-violation");
      expect(record.candidateCommit).toBeUndefined();
      expect(record.scope.violations).not.toHaveLength(0);
    }
  });

  it("blocks a required validation failure after a scope-compliant extraction", async () => {
    const item = await fixture({ failingValidation: true });
    const executionId = "E-40000000-0000-4000-8000-000000000005";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await applyValidExtraction(context.worktreePath);
      return executorResult();
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
      }),
    ).rejects.toMatchObject({
      exitCode: 9,
      code: "required-validation-failed",
    });
    const record = await store.loadRecord(executionId);
    expect(record.status).toBe("validation-failed");
    expect(record.candidateCommit).toBeUndefined();
  });

  it("rejects a new architecture cycle after source validation passes", async () => {
    const item = await fixture();
    const executionId = "E-50000000-0000-4000-8000-000000000006";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await applyValidExtraction(context.worktreePath, {
        introduceCycle: true,
      });
      return executorResult();
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
      }),
    ).rejects.toMatchObject({
      exitCode: 10,
      code: "architecture-validation-failed",
    });
    await expect(store.loadRecord(executionId)).resolves.toMatchObject({
      status: "needs-review",
      architecture: { actualImpact: { newCycles: 1 } },
    });
  });

  it("distinguishes no-op and timed-out executors", async () => {
    for (const timedOut of [false, true]) {
      const item = await fixture();
      const executionId = timedOut
        ? "E-60000000-0000-4000-8000-000000000007"
        : "E-60000000-0000-4000-8000-000000000008";
      const store = new JsonExecutionStore(item.repositoryRoot);
      const executor = new ScriptedTestExecutor(() =>
        executorResult({ timedOut }),
      );

      await expect(
        runMigration({
          ...runInput(item, executionId, executor),
          executionStore: store,
        }),
      ).rejects.toMatchObject({ exitCode: timedOut ? 7 : 8 });
      await expect(store.loadRecord(executionId)).resolves.toMatchObject({
        status: timedOut ? "executor-failed" : "no-changes",
      });
    }
  });

  it("rejects an executor-created commit before trusting its diff", async () => {
    const item = await fixture();
    const executionId = "E-65000000-0000-4000-8000-000000000013";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await writeFile(
        path.join(context.worktreePath, "src", "orders", "extra.ts"),
        "export {};\n",
      );
      await git(context.worktreePath, ["add", "src/orders/extra.ts"]);
      await git(context.worktreePath, [
        "-c",
        "user.name=Unauthorized Executor",
        "-c",
        "user.email=executor@example.invalid",
        "commit",
        "-qm",
        "unauthorized",
      ]);
      return executorResult();
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
      }),
    ).rejects.toMatchObject({
      exitCode: 8,
      code: "executor-created-commit",
    });
    const record = await store.loadRecord(executionId);
    expect(record.status).toBe("scope-violation");
    expect(record.candidateCommit).toBeUndefined();
  });

  it("detects an executor commit even when the executor throws", async () => {
    const item = await fixture();
    const executionId = "E-66000000-0000-4000-8000-000000000014";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await writeFile(
        path.join(context.worktreePath, "src", "orders", "extra.ts"),
        "export {};\n",
      );
      await git(context.worktreePath, ["add", "src/orders/extra.ts"]);
      await git(context.worktreePath, [
        "-c",
        "user.name=Unauthorized Executor",
        "-c",
        "user.email=executor@example.invalid",
        "commit",
        "-qm",
        "unauthorized",
      ]);
      throw new Error("executor crashed after committing");
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
      }),
    ).rejects.toMatchObject({
      exitCode: 8,
      code: "executor-created-commit",
    });
    await expect(store.loadRecord(executionId)).resolves.toMatchObject({
      status: "scope-violation",
      failure: { code: "executor-created-commit" },
    });
  });

  it("rejects dirty source before a worktree and retains a failed record", async () => {
    const item = await fixture();
    await writeFile(
      path.join(item.repositoryRoot, "src", "orders", "order-service.ts"),
      "export const stale = true;\n",
    );
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(() => executorResult());

    await expect(
      runMigration({
        ...runInput(item, "E-70000000-0000-4000-8000-000000000009", executor),
        executionStore: store,
      }),
    ).rejects.toMatchObject({ exitCode: 5, code: "dirty-repository" });
    await expect(store.listRecords()).resolves.toMatchObject([
      { status: "preflight-failed", failure: { code: "dirty-repository" } },
    ]);
  });

  it("detects a deliberate main-checkout mutation by the executor", async () => {
    const item = await fixture();
    const executionId = "E-80000000-0000-4000-8000-000000000010";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(async () => {
      await writeFile(
        path.join(item.repositoryRoot, "src", "orders", "order-service.ts"),
        "export const mutatedMain = true;\n",
      );
      return executorResult();
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
      }),
    ).rejects.toMatchObject({
      exitCode: 11,
      code: "main-checkout-mutated",
    });
    await expect(store.loadRecord(executionId)).resolves.toMatchObject({
      status: "executor-failed",
      failure: { stage: "main-integrity" },
    });
  });

  it("rejects a validation-created commit even with --no-commit semantics", async () => {
    const item = await fixture({ committingValidation: true });
    const executionId = "E-91000000-0000-4000-8000-000000000017";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await applyValidExtraction(context.worktreePath);
      return executorResult();
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
        createCommit: false,
      }),
    ).rejects.toMatchObject({
      exitCode: 8,
      code: "executor-created-commit",
    });
    const record = await store.loadRecord(executionId);
    expect(record).toMatchObject({
      status: "scope-violation",
      failure: { code: "executor-created-commit" },
    });
    expect(record.candidateCommit).toBeUndefined();
  });

  it("retains a validated dirty candidate without committing when requested", async () => {
    const item = await fixture();
    const executionId = "E-93000000-0000-4000-8000-000000000019";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const manager = new WorktreeManager({
      repositoryRoot: item.repositoryRoot,
      executionRoot: item.executionRoot,
    });
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await applyValidExtraction(context.worktreePath);
      return executorResult();
    });

    const result = await runMigration({
      ...runInput(item, executionId, executor),
      executionStore: store,
      worktreeManager: manager,
      createCommit: false,
    });
    const owned = await manager.load(executionId);
    expect(result.record.status).toBe("succeeded");
    expect(result.record.candidateCommit).toBeUndefined();
    expect(await git(owned.worktreePath, ["rev-parse", "HEAD"])).toBe(
      item.baseCommit,
    );
    expect(
      await git(owned.worktreePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).not.toBe("");
  });

  it("isolates a session-detached executor descendant from the candidate", async () => {
    const item = await fixture();
    const executionId = "E-95000000-0000-4000-8000-000000000021";
    const manager = new WorktreeManager({
      repositoryRoot: item.repositoryRoot,
      executionRoot: item.executionRoot,
    });
    let executorRoot = "";
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      executorRoot = context.worktreePath;
      await applyValidExtraction(context.worktreePath);
      const target = path.join(
        context.worktreePath,
        "src",
        "orders",
        "order-service.ts",
      );
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const { appendFileSync } = require("node:fs"); setTimeout(() => { try { appendFileSync(${JSON.stringify(target)}, "\\nexport const lateMutation = true;\\n"); } catch {} }, 750);`,
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      return executorResult();
    });

    const result = await runMigration({
      ...runInput(item, executionId, executor),
      worktreeManager: manager,
    });
    const owned = await manager.load(executionId);
    await new Promise((resolve) => setTimeout(resolve, 850));

    expect(result.record.status).toBe("succeeded");
    expect(executorRoot).not.toBe(owned.worktreePath);
    expect(
      await readFile(
        path.join(owned.worktreePath, "src", "orders", "order-service.ts"),
        "utf8",
      ),
    ).not.toContain("lateMutation");
    expect(await git(owned.worktreePath, ["status", "--porcelain=v1"])).toBe(
      "",
    );
  }, 15_000);

  it("rejects executor-created Git objects and refs inside staging", async () => {
    const item = await fixture();
    const executionId = "E-94000000-0000-4000-8000-000000000020";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await applyValidExtraction(context.worktreePath);
      const tree = await git(context.worktreePath, [
        "rev-parse",
        `${item.baseCommit}^{tree}`,
      ]);
      const unownedCommit = await git(context.worktreePath, [
        "-c",
        "user.name=Unauthorized Executor",
        "-c",
        "user.email=executor@example.invalid",
        "commit-tree",
        tree,
        "-p",
        item.baseCommit,
        "-m",
        "unowned exact-ref commit",
      ]);
      await git(context.worktreePath, ["switch", "--detach", item.baseCommit]);
      await git(context.worktreePath, [
        "update-ref",
        "refs/heads/braid/exec/94000000",
        unownedCommit,
        item.baseCommit,
      ]);
      return executorResult();
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
        createCommit: false,
      }),
    ).rejects.toMatchObject({
      exitCode: 8,
      code: "executor-created-commit",
    });
    await expect(store.loadRecord(executionId)).resolves.toMatchObject({
      status: "scope-violation",
      failure: { code: "executor-created-commit" },
    });
  });

  it("detects mutation of another braid execution ref", async () => {
    const item = await fixture();
    const executionId = "E-92000000-0000-4000-8000-000000000018";
    const store = new JsonExecutionStore(item.repositoryRoot);
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      await applyValidExtraction(context.worktreePath);
      await git(item.repositoryRoot, ["branch", "braid/exec/deadbeef"]);
      return executorResult();
    });

    await expect(
      runMigration({
        ...runInput(item, executionId, executor),
        executionStore: store,
      }),
    ).rejects.toMatchObject({
      exitCode: 11,
      code: "main-checkout-mutated",
    });
    await expect(store.loadRecord(executionId)).resolves.toMatchObject({
      status: "executor-failed",
      failure: { code: "main-checkout-mutated" },
    });
  });

  it("generates unique execution IDs", () => {
    expect(createExecutionId()).not.toBe(createExecutionId());
  });
});
