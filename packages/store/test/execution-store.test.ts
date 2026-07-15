import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrationExecutionPlanSchema,
  migrationExecutionRecordSchema,
  type MigrationExecutionPlan,
  type MigrationExecutionRecord,
  type MigrationExecutionStatus,
} from "@braid/core";
import { JsonExecutionStore } from "../src/execution-store.js";

const temporaryDirectories: string[] = [];
const hash = "a".repeat(64);
const commit = "b".repeat(40);
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
  const root = await mkdtemp(path.join(tmpdir(), "braid-executions-"));
  temporaryDirectories.push(root);
  return root;
};

const plan = (): MigrationExecutionPlan =>
  migrationExecutionPlanSchema.parse({
    schemaVersion: 1,
    planId: "PL-1234567890abcdef",
    proposalId: "P-EM-a18d42f3",
    proposalType: "extract-module",
    repository: {
      baseCommit: commit,
      sourceFingerprint: hash,
      configHash: hash,
      snapshotId: "S-example",
    },
    approval: { requiredProposalId: "P-EM-a18d42f3" },
    scope: {
      allowedExistingFiles: ["src/orders/order-service.ts"],
      allowedNewFilePatterns: ["src/notification/**"],
      allowedTestFiles: ["test/order-service.test.ts"],
      forbiddenFiles: ["package.json", "pnpm-lock.yaml"],
      maximumChangedFiles: 8,
    },
    expectedChange: {
      sourceFile: "src/orders/order-service.ts",
      sourceModule: "orders",
      suggestedModule: "notification",
      destinationDirectory: "src/notification",
      symbols: ["notificationLog", "sentNotifications"],
      predictedImpact: { simulated: [], estimated: [], unknowns: [] },
    },
    validation: {
      commands: [
        {
          id: "typecheck",
          stage: "typecheck",
          executable: "pnpm",
          arguments: ["typecheck"],
        },
      ],
    },
    executor: {
      kind: "codex",
      timeoutMs: 900_000,
      sandbox: "workspace-write",
    },
  });

const record = (
  executionId = firstExecution,
  status: MigrationExecutionStatus = "planned",
): MigrationExecutionRecord =>
  migrationExecutionRecordSchema.parse({
    schemaVersion: 1,
    executionId,
    planId: "PL-1234567890abcdef",
    proposalId: "P-EM-a18d42f3",
    status,
    startedAt: "2026-07-15T00:00:00.000Z",
    baseCommit: commit,
    executor: { kind: "codex", sandbox: "workspace-write" },
    scope: {
      allowedFiles: [
        "src/notification/**",
        "src/orders/order-service.ts",
        "test/order-service.test.ts",
      ],
      changedFiles: [],
      addedFiles: [],
      deletedFiles: [],
      violations: [],
    },
    validation: [],
    architecture: {
      beforeSnapshotId: "S-example",
      predictedImpact: { simulated: [], estimated: [], unknowns: [] },
    },
    fingerprints: {
      mainBefore: hash,
      candidateBefore: hash,
    },
    artifacts: {},
  });

const successfulImpact = {
  selectedSymbolsMoved: true,
  sourceModuleChanged: true,
  destinationModuleChanged: true,
  metrics: {
    internalImports: { before: 0, after: 1, delta: 1 },
    crossModuleImports: { before: 0, after: 1, delta: 1 },
    cycles: { before: 0, after: 0, delta: 0 },
    oversizedFiles: { before: 1, after: 0, delta: -1 },
    oversizedModules: { before: 0, after: 0, delta: 0 },
    publicEntrypoints: { before: 0, after: 0, delta: 0 },
  },
  newCycles: 0,
  publicApiChanged: false,
  protectedPathViolation: false,
  intendedOutcomeAchieved: true,
} as const;

describe("JSON execution store", () => {
  it("atomically persists an immutable, idempotent execution plan", async () => {
    const root = await temporaryRoot();
    const store = new JsonExecutionStore(root);
    const item = plan();
    const destination = await store.savePlan(firstExecution, item);

    await expect(store.loadPlan(firstExecution)).resolves.toEqual(item);
    await expect(store.savePlan(firstExecution, item)).resolves.toBe(
      destination,
    );
    await expect(
      store.savePlan(firstExecution, {
        ...item,
        scope: { ...item.scope, maximumChangedFiles: 7 },
      }),
    ).rejects.toThrow(/different content/u);
    expect(
      (await readdir(path.dirname(destination))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("allows only idempotent writes and valid record status transitions", async () => {
    const root = await temporaryRoot();
    const store = new JsonExecutionStore(root);
    await store.savePlan(firstExecution, plan());
    const planned = record();
    const destination = await store.saveRecord(planned);

    await expect(store.saveRecord(planned)).resolves.toBe(destination);
    await expect(
      store.saveRecord({
        ...planned,
        scope: {
          ...planned.scope,
          changedFiles: ["src/orders/order-service.ts"],
        },
      }),
    ).rejects.toThrow(/different content/u);

    const worktreeCreated = {
      ...planned,
      status: "worktree-created" as const,
      candidateBranch: "braid/exec/00000000",
    };
    const running = { ...worktreeCreated, status: "running" as const };
    const succeeded = migrationExecutionRecordSchema.parse({
      ...running,
      status: "succeeded" as const,
      completedAt: "2026-07-15T00:05:00.000Z",
      candidateCommit: "c".repeat(40),
      executor: {
        ...running.executor,
        sandbox: "workspace-write",
        exitCode: 0,
        timedOut: false,
      },
      scope: {
        ...running.scope,
        changedFiles: ["src/orders/order-service.ts"],
      },
      validation: [
        {
          commandId: "typecheck",
          stage: "typecheck",
          status: "passed",
          required: true,
          exitCode: 0,
          durationMs: 10,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
      architecture: {
        ...running.architecture,
        afterSnapshotId: "S-after",
        actualImpact: successfulImpact,
        comparison: {
          predicted: running.architecture.predictedImpact,
          actual: successfulImpact,
          mismatches: [],
        },
      },
      fingerprints: {
        ...running.fingerprints,
        mainAfter: hash,
        candidateAfter: hash,
        diffHash: hash,
      },
      artifacts: {
        eventLog: "codex-events.jsonl",
        finalSummary: "codex-summary.json",
        patch: "candidate.patch",
        validationReport: "validation.json",
      },
    });
    await store.saveRecord(worktreeCreated);
    await store.saveRecord(running);
    await expect(
      store.saveRecord({
        ...succeeded,
        fingerprints: {
          ...succeeded.fingerprints,
          mainBefore: "c".repeat(64),
          mainAfter: "c".repeat(64),
        },
      }),
    ).rejects.toThrow(/changed immutable evidence/u);
    await expect(
      store.saveRecord({
        ...succeeded,
        validation: [
          { ...succeeded.validation[0]!, commandId: "unplanned-check" },
        ],
      }),
    ).rejects.toThrow(/complete plan validation evidence/u);
    await store.saveRecord(succeeded);
    await expect(store.loadRecord(firstExecution)).resolves.toEqual(succeeded);
    await expect(store.saveRecord(running)).rejects.toThrow(
      /succeeded -> running/u,
    );
  });

  it("lists records deterministically and recovers interrupted executions", async () => {
    const root = await temporaryRoot();
    const store = new JsonExecutionStore(root);
    await store.savePlan(firstExecution, plan());
    await store.savePlan(secondExecution, plan());
    const stable = record(secondExecution);
    const planned = record(firstExecution);
    await store.saveRecord(stable);
    await store.saveRecord(planned);
    const worktreeCreated = {
      ...planned,
      status: "worktree-created" as const,
      candidateBranch: "braid/exec/00000000",
    };
    await store.saveRecord(worktreeCreated);
    await store.saveRecord({ ...worktreeCreated, status: "running" });

    expect((await store.listRecords()).map((item) => item.executionId)).toEqual(
      [firstExecution, secondExecution],
    );
    const recovered = await store.recoverInterrupted();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      executionId: firstExecution,
      status: "executor-failed",
      failure: { stage: "executor", code: "interrupted-execution" },
    });
    await expect(store.recoverInterrupted()).resolves.toEqual([]);
    await expect(store.loadRecord(secondExecution)).resolves.toEqual(stable);
  });

  it("serializes concurrent terminal transitions without overwriting a winner", async () => {
    const root = await temporaryRoot();
    const store = new JsonExecutionStore(root);
    await store.savePlan(firstExecution, plan());
    const planned = record();
    const worktreeCreated = {
      ...planned,
      status: "worktree-created" as const,
      candidateBranch: "braid/exec/00000000",
    };
    const running = { ...worktreeCreated, status: "running" as const };
    await store.saveRecord(planned);
    await store.saveRecord(worktreeCreated);
    await store.saveRecord(running);

    const terminal = (status: "executor-failed" | "no-changes") => ({
      ...running,
      status,
      completedAt: "2026-07-15T00:05:00.000Z",
      failure: { stage: "executor", code: status, message: status },
    });
    const writes = await Promise.allSettled([
      store.saveRecord(terminal("executor-failed")),
      store.saveRecord(terminal("no-changes")),
    ]);

    expect(writes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(writes.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(["executor-failed", "no-changes"]).toContain(
      (await store.loadRecord(firstExecution)).status,
    );
  });

  it("atomically writes immutable text and portable JSON artifacts", async () => {
    const root = await temporaryRoot();
    const store = new JsonExecutionStore(root);
    const textPath = await store.writeTextArtifact(
      firstExecution,
      "candidate.patch",
      "diff --git a/src/a.ts b/src/a.ts\n",
    );
    const jsonPath = await store.writeJsonArtifact(
      firstExecution,
      "reports/scope.json",
      { changedFiles: ["src/orders/order-service.ts"] },
    );

    expect(textPath).toBe(
      `.braid/executions/${firstExecution}/candidate.patch`,
    );
    await expect(
      readFile(path.join(root, textPath), "utf8"),
    ).resolves.toContain("diff --git");
    await expect(
      readFile(path.join(root, jsonPath), "utf8"),
    ).resolves.toContain("src/orders/order-service.ts");
    await expect(
      store.writeTextArtifact(firstExecution, "candidate.patch", "different"),
    ).rejects.toThrow(/different content/u);
    await expect(
      store.writeJsonArtifact(firstExecution, "scope.json", {
        worktree: "/Users/private/worktree",
      }),
    ).rejects.toThrow(/absolute path/u);
  });

  it("rejects artifact escapes and absolute paths before schema stripping", async () => {
    const root = await temporaryRoot();
    const store = new JsonExecutionStore(root);
    await expect(
      store.writeTextArtifact(firstExecution, "../outside.log", "unsafe"),
    ).rejects.toThrow(/Invalid execution artifact path/u);
    await expect(
      store.writeTextArtifact(firstExecution, "/tmp/outside.log", "unsafe"),
    ).rejects.toThrow(/Invalid execution artifact path/u);
    await expect(
      store.writeJsonArtifact(firstExecution, "plan.json", {}),
    ).rejects.toThrow(/Invalid execution artifact path/u);

    const directory = path.join(root, ".braid", "executions", firstExecution);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "plan.json"),
      JSON.stringify({ ...plan(), privateWorktree: "/private/tmp/worktree" }),
    );
    await expect(store.loadPlan(firstExecution)).rejects.toThrow(
      /absolute path/u,
    );
  });
});
