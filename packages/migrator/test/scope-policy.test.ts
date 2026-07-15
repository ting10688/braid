import path from "node:path";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrationExecutionPlanSchema,
  type MigrationExecutionPlan,
} from "@braid/core";
import { inspectMigrationScope } from "../src/scope-policy.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const git = async (root: string, arguments_: string[]): Promise<string> =>
  (
    await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
    })
  ).stdout.trim();

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-scope-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src", "orders"), { recursive: true });
  await writeFile(
    path.join(root, "src", "orders", "order.ts"),
    "export const notificationLog = () => 'before';\n",
  );
  await writeFile(
    path.join(root, "src", "index.ts"),
    "export * from './orders/order';\n",
  );
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await git(root, ["init", "-q"]);
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Braid Test",
    "-c",
    "user.email=braid@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  return { root, commit: await git(root, ["rev-parse", "HEAD"]) };
};

const planFor = (
  commit: string,
  maximumChangedFiles = 8,
  allowedExistingFiles = ["src/orders/order.ts"],
): MigrationExecutionPlan =>
  migrationExecutionPlanSchema.parse({
    schemaVersion: 1,
    planId: "PL-0123456789abcdef",
    proposalId: "P-EM-12345678",
    proposalType: "extract-module",
    repository: {
      baseCommit: commit,
      sourceFingerprint: "a".repeat(64),
      configHash: "b".repeat(64),
      snapshotId: "snapshot",
    },
    approval: { requiredProposalId: "P-EM-12345678" },
    scope: {
      allowedExistingFiles,
      allowedNewFilePatterns: ["src/notification/**", "vendor/**"],
      allowedTestFiles: [],
      forbiddenFiles: [
        ".braid/**",
        ".env*",
        ".git/**",
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig*.json",
      ],
      maximumChangedFiles,
    },
    expectedChange: {
      sourceFile: "src/orders/order.ts",
      sourceModule: "orders",
      suggestedModule: "notification",
      destinationDirectory: "src/notification",
      symbols: ["notificationLog", "sentNotifications"],
      predictedImpact: { simulated: [], estimated: [], unknowns: [] },
    },
    validation: {
      commands: [
        {
          id: "test",
          stage: "unit-test",
          executable: "node",
          arguments: ["--test"],
        },
      ],
    },
    executor: {
      kind: "scripted-test",
      timeoutMs: 10_000,
      sandbox: "workspace-write",
    },
  });

describe("migration scope policy", () => {
  it("accepts approved source and destination changes with a stable patch hash", async () => {
    const { root, commit } = await fixture();
    await writeFile(
      path.join(root, "src", "orders", "order.ts"),
      "export { notificationLog } from '../notification/index';\n",
    );
    await mkdir(path.join(root, "src", "notification"), { recursive: true });
    await writeFile(
      path.join(root, "src", "notification", "index.ts"),
      "export const notificationLog = () => 'after';\n",
    );
    const input = { worktreeRoot: root, plan: planFor(commit) };
    const first = await inspectMigrationScope(input);
    const second = await inspectMigrationScope(input);
    expect(first).toMatchObject({
      compliant: true,
      addedFiles: ["src/notification/index.ts"],
      modifiedFiles: ["src/orders/order.ts"],
      violations: [],
    });
    expect(first.patchHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.patchHash).toBe(first.patchHash);
    expect(first.patch).toContain("src/notification/index.ts");
  });

  it("rejects an untracked same-name file in an unrelated directory", async () => {
    const { root, commit } = await fixture();
    await mkdir(path.join(root, "src", "other"), { recursive: true });
    await writeFile(
      path.join(root, "src", "other", "order.ts"),
      "unrelated();\n",
    );
    const result = await inspectMigrationScope({
      worktreeRoot: root,
      plan: planFor(commit),
    });
    expect(result.addedFiles).toEqual(["src/other/order.ts"]);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "unauthorized-path",
        path: "src/other/order.ts",
      }),
    );
  });

  it("hard-fails package and public entrypoint changes", async () => {
    const { root, commit } = await fixture();
    await writeFile(
      path.join(root, "package.json"),
      '{"dependencies":{"x":"1"}}\n',
    );
    await writeFile(
      path.join(root, "src", "index.ts"),
      "export const changed = true;\n",
    );
    const result = await inspectMigrationScope({
      worktreeRoot: root,
      plan: planFor(commit, 8, [
        "src/orders/order.ts",
        "src/index.ts",
        "package.json",
      ]),
      publicEntrypoints: ["src/index.ts"],
    });
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dependency-change",
          path: "package.json",
        }),
        expect.objectContaining({
          code: "public-entrypoint-change",
          path: "src/index.ts",
        }),
      ]),
    );
  });

  it("detects ignored forbidden files without retaining their contents", async () => {
    const { root, commit } = await fixture();
    await writeFile(path.join(root, ".gitignore"), ".env*\n");
    await writeFile(path.join(root, ".env.secret"), "TOKEN=do-not-persist\n");
    const result = await inspectMigrationScope({
      worktreeRoot: root,
      plan: planFor(commit),
    });
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "forbidden-path",
        path: ".env.secret",
      }),
    );
    expect(result.patch).toBe("");
    expect(JSON.stringify(result)).not.toContain("do-not-persist");
  });

  it("rejects credential-like content without retaining it in the patch", async () => {
    const { root, commit } = await fixture();
    await mkdir(path.join(root, "src", "notification"), { recursive: true });
    await writeFile(
      path.join(root, "src", "notification", "credentials.ts"),
      "export const OPENAI_API_KEY = 'sk-123456789abcdef';\n",
    );

    const result = await inspectMigrationScope({
      worktreeRoot: root,
      plan: planFor(commit),
    });

    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "secret-detected" }),
    );
    expect(result.patch).toBe("");
    expect(JSON.stringify(result)).not.toContain("sk-123456789abcdef");
  });

  it("rejects binary and symlink additions even inside the destination", async () => {
    const { root, commit } = await fixture();
    await mkdir(path.join(root, "src", "notification"), { recursive: true });
    await writeFile(
      path.join(root, "src", "notification", "asset.bin"),
      Buffer.from([0, 1, 2, 3]),
    );
    await symlink(
      "../orders/order.ts",
      path.join(root, "src", "notification", "linked.ts"),
    );
    await writeFile(
      path.join(root, "src", "notification", "executable.ts"),
      "export {};\n",
      { mode: 0o755 },
    );
    const result = await inspectMigrationScope({
      worktreeRoot: root,
      plan: planFor(commit),
    });
    expect(result.binaryFiles).toContain("src/notification/asset.bin");
    expect(result.symlinkChanges).toContain("src/notification/linked.ts");
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "binary-file" }),
        expect.objectContaining({ code: "symlink-change" }),
        expect.objectContaining({
          code: "mode-change",
          path: "src/notification/executable.ts",
        }),
      ]),
    );
  });

  it("rejects deletion and a changed-file count above the plan limit", async () => {
    const { root, commit } = await fixture();
    await rm(path.join(root, "src", "orders", "order.ts"));
    await mkdir(path.join(root, "src", "notification"), { recursive: true });
    await writeFile(
      path.join(root, "src", "notification", "index.ts"),
      "export {};\n",
    );
    const result = await inspectMigrationScope({
      worktreeRoot: root,
      plan: planFor(commit, 1),
    });
    expect(result.deletedFiles).toContain("src/orders/order.ts");
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "deleted-file" }),
        expect.objectContaining({ code: "changed-file-limit" }),
      ]),
    );
  });

  it("detects renames, executable-bit changes, and submodule entries", async () => {
    const { root, commit } = await fixture();
    await mkdir(path.join(root, "src", "notification"), { recursive: true });
    await git(root, ["mv", "src/orders/order.ts", "src/notification/order.ts"]);
    await chmod(path.join(root, "src", "index.ts"), 0o755);
    await git(root, ["update-index", "--chmod=+x", "src/index.ts"]);
    await git(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${commit},vendor/library`,
    ]);
    const result = await inspectMigrationScope({
      worktreeRoot: root,
      plan: planFor(commit, 8, ["src/orders/order.ts", "src/index.ts"]),
    });
    expect(result.renamedFiles).toContainEqual({
      from: "src/orders/order.ts",
      to: "src/notification/order.ts",
    });
    expect(result.modeChanges).toContainEqual(
      expect.objectContaining({ path: "src/index.ts" }),
    );
    expect(result.submoduleChanges).toContain("vendor/library");
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "deleted-file" }),
        expect.objectContaining({ code: "mode-change" }),
        expect.objectContaining({ code: "submodule-change" }),
      ]),
    );
  });
});
