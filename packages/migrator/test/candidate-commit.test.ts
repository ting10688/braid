import path from "node:path";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateCommit } from "../src/candidate-commit.js";
import { hashNormalizedPatch } from "../src/scope-policy.js";

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

const candidateBranch = "braid/exec/c0ffee00";

const repository = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-candidate-"));
  temporaryDirectories.push(root);
  await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["init", "-q", root]);
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
  const baseCommit = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["switch", "-qc", candidateBranch]);
  return { root, baseCommit };
};

const patchHash = async (root: string): Promise<string> => {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      root,
      "diff",
      "HEAD",
      "--binary",
      "--no-ext-diff",
      "--no-color",
      "--unified=0",
      "--",
    ],
    { encoding: "utf8" },
  );
  return hashNormalizedPatch(stdout);
};

describe("createCandidateCommit", () => {
  it("creates exactly one controlled commit with trailers and the base parent", async () => {
    const fixture = await repository();
    await writeFile(
      path.join(fixture.root, "source.ts"),
      "export const value = 2;\n",
    );
    const candidateCommit = await createCandidateCommit({
      worktreePath: fixture.root,
      baseCommit: fixture.baseCommit,
      candidateBranch,
      proposalId: "P-EM-a18d42f3",
      executionId: "E-55555555-5555-4555-8555-555555555555",
      planId: "PL-0123456789abcdef",
      changedFiles: ["source.ts"],
      expectedPatchHash: await patchHash(fixture.root),
    });

    expect(await git(fixture.root, ["rev-parse", `${candidateCommit}^`])).toBe(
      fixture.baseCommit,
    );
    expect(
      await git(fixture.root, ["rev-list", "--count", "HEAD^..HEAD"]),
    ).toBe("1");
    const message = await git(fixture.root, ["show", "-s", "--format=%B"]);
    expect(message).toContain("braid: execute P-EM-a18d42f3");
    expect(message).toContain("Braid-Proposal: P-EM-a18d42f3");
    expect(message).toContain(
      "Braid-Execution: E-55555555-5555-4555-8555-555555555555",
    );
    expect(message).toContain("Braid-Plan: PL-0123456789abcdef");
    expect(
      await git(fixture.root, ["config", "--get", "user.email"]).catch(
        () => "",
      ),
    ).toBe("");
  });

  it("rejects an executor-created commit", async () => {
    const fixture = await repository();
    await writeFile(path.join(fixture.root, "other.ts"), "export {};\n");
    await git(fixture.root, ["add", "other.ts"]);
    await git(fixture.root, [
      "-c",
      "user.name=Executor",
      "-c",
      "user.email=executor@example.invalid",
      "commit",
      "-qm",
      "unauthorized",
    ]);

    await expect(
      createCandidateCommit({
        worktreePath: fixture.root,
        baseCommit: fixture.baseCommit,
        candidateBranch,
        proposalId: "P-EM-a18d42f3",
        executionId: "E-66666666-6666-4666-8666-666666666666",
        planId: "PL-fedcba9876543210",
        changedFiles: ["other.ts"],
        expectedPatchHash: hashNormalizedPatch(""),
      }),
    ).rejects.toMatchObject({ exitCode: 8, code: "executor-created-commit" });
  });

  it("disables commit, index, and reference-transaction hooks", async () => {
    const fixture = await repository();
    for (const hookName of [
      "post-commit",
      "post-index-change",
      "reference-transaction",
    ]) {
      const hook = path.join(fixture.root, ".git", "hooks", hookName);
      await writeFile(
        hook,
        `#!/bin/sh\ntouch "$PWD/${hookName}-ran"\nexit 1\n`,
      );
      await chmod(hook, 0o755);
    }
    await writeFile(
      path.join(fixture.root, "source.ts"),
      "export const value = 3;\n",
    );

    await createCandidateCommit({
      worktreePath: fixture.root,
      baseCommit: fixture.baseCommit,
      candidateBranch,
      proposalId: "P-EM-a18d42f3",
      executionId: "E-77777777-7777-4777-8777-777777777777",
      planId: "PL-1111111111111111",
      changedFiles: ["source.ts"],
      expectedPatchHash: await patchHash(fixture.root),
    });

    for (const hookName of [
      "post-commit",
      "post-index-change",
      "reference-transaction",
    ])
      await expect(
        access(path.join(fixture.root, `${hookName}-ran`)),
      ).rejects.toThrow();
  });

  it("refuses a candidate tree that changed after validation", async () => {
    const fixture = await repository();
    await writeFile(
      path.join(fixture.root, "source.ts"),
      "export const value = 4;\n",
    );
    const validatedPatchHash = await patchHash(fixture.root);
    await writeFile(
      path.join(fixture.root, "source.ts"),
      "export const value = 5;\n",
    );

    await expect(
      createCandidateCommit({
        worktreePath: fixture.root,
        baseCommit: fixture.baseCommit,
        candidateBranch,
        proposalId: "P-EM-a18d42f3",
        executionId: "E-88888888-8888-4888-8888-888888888888",
        planId: "PL-2222222222222222",
        changedFiles: ["source.ts"],
        expectedPatchHash: validatedPatchHash,
      }),
    ).rejects.toMatchObject({ exitCode: 8, code: "candidate-diff-changed" });
    expect(await git(fixture.root, ["rev-parse", "HEAD"])).toBe(
      fixture.baseCommit,
    );
  });
});
