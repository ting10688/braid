import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateCommit } from "../src/candidate-commit.js";
import { hashNormalizedPatch } from "../src/scope-policy.js";
import { WorktreeManager } from "../src/worktree-manager.js";

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

const fixtureRepository = async () => {
  const container = await mkdtemp(path.join(tmpdir(), "braid-worktree-"));
  temporaryDirectories.push(container);
  const repositoryRoot = path.join(container, "main");
  const executionRoot = path.join(container, "executions");
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(
    path.join(repositoryRoot, ".gitignore"),
    ".braid/executions/\n",
  );
  await writeFile(
    path.join(repositoryRoot, "source.ts"),
    "export const value = 1;\n",
  );
  await execFileAsync("git", ["init", "-q", repositoryRoot]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, [
    "-c",
    "user.name=Braid Test",
    "-c",
    "user.email=braid@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  return {
    repositoryRoot,
    executionRoot,
    baseCommit: await git(repositoryRoot, ["rev-parse", "HEAD"]),
    manager: new WorktreeManager({ repositoryRoot, executionRoot }),
  };
};

describe("WorktreeManager", () => {
  it("creates a clean, exact-base worktree outside the main checkout", async () => {
    const fixture = await fixtureRepository();
    const headBefore = await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const remoteBefore = await git(fixture.repositoryRoot, [
      "config",
      "--local",
      "--list",
    ]);
    const owned = await fixture.manager.create(
      "E-11111111-1111-4111-8111-111111111111",
      fixture.baseCommit,
    );

    expect(path.relative(fixture.repositoryRoot, owned.worktreePath)).toMatch(
      /^\.\./u,
    );
    expect(await git(owned.worktreePath, ["rev-parse", "HEAD"])).toBe(
      fixture.baseCommit,
    );
    expect(await git(owned.worktreePath, ["status", "--porcelain=v1"])).toBe(
      "",
    );
    expect(await git(fixture.repositoryRoot, ["rev-parse", "HEAD"])).toBe(
      headBefore,
    );
    expect(
      await git(fixture.repositoryRoot, ["config", "--local", "--list"]),
    ).toBe(remoteBefore);
  });

  it("refuses unknown execution deletion and safely discards an owned branch", async () => {
    const fixture = await fixtureRepository();
    await expect(
      fixture.manager.discard("E-22222222-2222-4222-8222-222222222222"),
    ).rejects.toMatchObject({ exitCode: 12, code: "unknown-worktree" });

    const executionId = "E-33333333-3333-4333-8333-333333333333";
    const owned = await fixture.manager.create(executionId, fixture.baseCommit);
    await fixture.manager.discard(executionId);

    await expect(
      git(fixture.repositoryRoot, ["rev-parse", owned.branch]),
    ).rejects.toBeDefined();
    await expect(fixture.manager.discard(executionId)).resolves.toBeUndefined();
    await expect(
      fixture.manager.create(executionId, fixture.baseCommit),
    ).rejects.toMatchObject({
      exitCode: 6,
      code: "execution-already-owned",
    });
  });

  it("refuses to discard a branch containing an unrelated commit", async () => {
    const fixture = await fixtureRepository();
    const executionId = "E-44444444-4444-4444-8444-444444444444";
    const owned = await fixture.manager.create(executionId, fixture.baseCommit);
    await writeFile(
      path.join(owned.worktreePath, "unrelated.ts"),
      "export {};\n",
    );
    await git(owned.worktreePath, ["add", "unrelated.ts"]);
    await git(owned.worktreePath, [
      "-c",
      "user.name=User",
      "-c",
      "user.email=user@example.invalid",
      "commit",
      "-qm",
      "unrelated",
    ]);

    await expect(fixture.manager.discard(executionId)).rejects.toMatchObject({
      exitCode: 12,
      code: "unowned-branch-commit",
    });
    expect(
      await git(fixture.repositoryRoot, ["rev-parse", owned.branch]),
    ).not.toBe(fixture.baseCommit);
  });

  it("rejects an execution-root symlink that resolves into the main checkout", async () => {
    const fixture = await fixtureRepository();
    await symlink(fixture.repositoryRoot, fixture.executionRoot, "dir");

    await expect(
      fixture.manager.create(
        "E-55555555-5555-4555-8555-555555555555",
        fixture.baseCommit,
      ),
    ).rejects.toMatchObject({ exitCode: 6, code: "worktree-inside-main" });
  });

  it("detects a candidate ref that was moved and restored", async () => {
    const fixture = await fixtureRepository();
    const executionId = "E-56565656-5656-4656-8656-565656565656";
    const owned = await fixture.manager.create(executionId, fixture.baseCommit);
    const tree = await git(fixture.repositoryRoot, [
      "rev-parse",
      `${fixture.baseCommit}^{tree}`,
    ]);
    const unownedCommit = await git(fixture.repositoryRoot, [
      "-c",
      "user.name=Unauthorized",
      "-c",
      "user.email=unauthorized@example.invalid",
      "commit-tree",
      tree,
      "-p",
      fixture.baseCommit,
      "-m",
      "unowned",
    ]);
    await git(fixture.repositoryRoot, [
      "update-ref",
      `refs/heads/${owned.branch}`,
      unownedCommit,
      fixture.baseCommit,
    ]);
    await git(fixture.repositoryRoot, [
      "update-ref",
      `refs/heads/${owned.branch}`,
      fixture.baseCommit,
      unownedCommit,
    ]);

    await expect(
      fixture.manager.assertOwnedState(executionId, fixture.baseCommit),
    ).rejects.toMatchObject({
      exitCode: 8,
      code: "owned-worktree-state-changed",
    });
  });

  it("recovers a controlled candidate commit if locator finalization was interrupted", async () => {
    const fixture = await fixtureRepository();
    const executionId = "E-66666666-6666-4666-8666-666666666666";
    const proposalId = "P-EM-a18d42f3";
    const planId = "PL-1234567890abcdef";
    const owned = await fixture.manager.create(
      executionId,
      fixture.baseCommit,
      { proposalId, planId },
    );
    await writeFile(
      path.join(owned.worktreePath, "source.ts"),
      "export const value = 2;\n",
    );
    await createCandidateCommit({
      worktreePath: owned.worktreePath,
      baseCommit: fixture.baseCommit,
      candidateBranch: owned.branch,
      proposalId,
      executionId,
      planId,
      changedFiles: ["source.ts"],
      expectedPatchHash: hashNormalizedPatch(
        await git(owned.worktreePath, [
          "diff",
          "HEAD",
          "--binary",
          "--no-ext-diff",
          "--no-color",
          "--unified=0",
          "--",
        ]),
      ),
    });

    await fixture.manager.discard(executionId);

    await expect(
      git(fixture.repositoryRoot, ["rev-parse", owned.branch]),
    ).rejects.toBeDefined();
    await expect(fixture.manager.discard(executionId)).resolves.toBeUndefined();
  });
});
