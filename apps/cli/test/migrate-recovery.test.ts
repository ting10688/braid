import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Migrator from "@braid/migrator";

const recoveryMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  inspect: vi.fn(),
  list: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@braid/migrator", async (importOriginal) => ({
  ...(await importOriginal<typeof Migrator>()),
  cleanupMigrationRecovery: recoveryMocks.cleanup,
  inspectMigrationRecovery: recoveryMocks.inspect,
  listMigrationRecoveries: recoveryMocks.list,
  resumeMigration: recoveryMocks.resume,
}));

import {
  migrateCleanupCommand,
  migrateRecoverCommand,
  migrateResumeCommand,
} from "../src/commands/migrate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  recoveryMocks.cleanup.mockReset();
  recoveryMocks.inspect.mockReset();
  recoveryMocks.list.mockReset();
  recoveryMocks.resume.mockReset();
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

const executionA = "E-a0000000-0000-4000-8000-000000000001";
const executionB = "E-b0000000-0000-4000-8000-000000000002";

const report = (executionId = executionA) => ({
  schemaVersion: "1.0.0" as const,
  reportId: "RR-0000000000000000",
  executionId,
  classification: "resumable" as const,
  latestCheckpoint: "patch-captured" as const,
  integrity: { valid: true, temporaryFiles: [] },
  nextSafeAction: "Resume from scope verification.",
  executorLaunchPermitted: false,
  candidateCreationPermitted: false,
  cleanupEligible: false,
  lock: { status: "unlocked" as const },
  resources: [],
});

describe("migrate recovery CLI commands", () => {
  it("writes one JSON document and keeps recover inspection read-only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-cli-recover-"));
    temporaryDirectories.push(root);
    recoveryMocks.inspect.mockResolvedValue(report());
    const output = captureStdout();

    await migrateRecoverCommand(executionA, { path: root, json: true });

    expect(JSON.parse(output())).toEqual(report());
    expect(recoveryMocks.inspect).toHaveBeenCalledWith({
      repositoryRoot: root,
      executionId: executionA,
    });
    expect(recoveryMocks.resume).not.toHaveBeenCalled();
    expect(recoveryMocks.cleanup).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("renders the required human recovery fields", async () => {
    recoveryMocks.inspect.mockResolvedValue(report());
    const output = captureStdout();

    await migrateRecoverCommand(executionA, {});

    expect(output()).toContain(`Execution: ${executionA}`);
    expect(output()).toContain("Classification: resumable");
    expect(output()).toContain("Latest checkpoint: patch-captured");
    expect(output()).toContain("Integrity: valid");
    expect(output()).toContain(
      "Next safe action: Resume from scope verification.",
    );
    expect(output()).toContain("Executor launch permitted: no");
    expect(output()).toContain("Candidate creation permitted: no");
    expect(output()).toContain("Cleanup eligible: no");
  });

  it("sorts recovery listings deterministically", async () => {
    recoveryMocks.list.mockResolvedValue([report(executionB), report()]);
    const output = captureStdout();

    await migrateRecoverCommand(undefined, { json: true });

    expect(
      JSON.parse(output()).map(
        ({ executionId }: { executionId: string }) => executionId,
      ),
    ).toEqual([executionA, executionB]);
  });

  it("refuses resume and cleanup without exact confirmation", async () => {
    await expect(
      migrateResumeCommand(executionA, { confirm: executionB }),
    ).rejects.toMatchObject({
      exitCode: 12,
      code: "recovery-confirmation-mismatch",
    });
    await expect(
      migrateCleanupCommand(executionA, { confirm: executionB }),
    ).rejects.toMatchObject({
      exitCode: 12,
      code: "recovery-confirmation-mismatch",
    });
    expect(recoveryMocks.resume).not.toHaveBeenCalled();
    expect(recoveryMocks.cleanup).not.toHaveBeenCalled();
  });

  it("prints cleanup recovery evidence as human output", async () => {
    recoveryMocks.cleanup.mockResolvedValue({
      ...report(),
      classification: "unsafe-to-resume",
      nextSafeAction: "Manual inspection required.",
    });
    const output = captureStdout();

    await migrateCleanupCommand(executionA, {
      confirm: executionA,
    });

    expect(recoveryMocks.cleanup).toHaveBeenCalledWith({
      repositoryRoot: process.cwd(),
      executionId: executionA,
    });
    expect(output()).toContain("Classification: unsafe-to-resume");
    expect(output()).toContain("Next safe action: Manual inspection required.");
  });
});
