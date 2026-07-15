import path from "node:path";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { MigrationSafetyError } from "@braid/shared";
import { hashNormalizedPatch } from "./scope-policy.js";

const execFileAsync = promisify(execFile);

const gitRaw = async (
  worktreePath: string,
  arguments_: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string> =>
  (
    await execFileAsync("git", ["-C", worktreePath, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(environment ? { env: environment } : {}),
    })
  ).stdout;

const git = async (
  worktreePath: string,
  arguments_: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string> =>
  (await gitRaw(worktreePath, arguments_, environment)).trim();

const sorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

export const assertExecutorDidNotCommit = async (
  worktreePath: string,
  baseCommit: string,
): Promise<void> => {
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  if (head !== baseCommit)
    throw new MigrationSafetyError(
      "Executor or validation command created an unauthorized commit",
      8,
      "executor-created-commit",
    );
};

export const createCandidateCommit = async (input: {
  worktreePath: string;
  baseCommit: string;
  candidateBranch: string;
  proposalId: string;
  executionId: string;
  planId: string;
  changedFiles: string[];
  expectedPatchHash: string;
}): Promise<string> => {
  await assertExecutorDidNotCommit(input.worktreePath, input.baseCommit);
  if (!/^braid\/exec\/[a-f0-9]{8}$/u.test(input.candidateBranch))
    throw new MigrationSafetyError(
      "Candidate branch identity is invalid",
      8,
      "candidate-branch-invalid",
    );
  if (!/^[a-f0-9]{64}$/u.test(input.expectedPatchHash))
    throw new MigrationSafetyError(
      "Validated patch identity is invalid",
      8,
      "candidate-patch-invalid",
    );
  const branchRef = await git(input.worktreePath, ["symbolic-ref", "HEAD"]);
  if (branchRef !== `refs/heads/${input.candidateBranch}`)
    throw new MigrationSafetyError(
      "Candidate worktree is not on its owned branch",
      8,
      "candidate-branch-mismatch",
    );

  const expectedFiles = sorted(input.changedFiles);
  const temporaryIndexDirectory = await mkdtemp(
    path.join(tmpdir(), "braid-candidate-index-"),
  );
  const disabledHooks = path.join(temporaryIndexDirectory, "disabled-hooks");
  await mkdir(disabledHooks);
  const hookless = ["-c", `core.hooksPath=${disabledHooks}`];
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: path.join(temporaryIndexDirectory, "index"),
  };
  try {
    await git(
      input.worktreePath,
      [...hookless, "read-tree", input.baseCommit],
      environment,
    );
    await git(
      input.worktreePath,
      [...hookless, "add", "--", ...expectedFiles],
      environment,
    );
    const staged = (
      await gitRaw(
        input.worktreePath,
        [...hookless, "diff", "--cached", "--name-only", "-z", "HEAD", "--"],
        environment,
      )
    )
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(staged) !== JSON.stringify(expectedFiles))
      throw new MigrationSafetyError(
        "Candidate tree files do not match the validated migration scope",
        8,
        "candidate-staging-mismatch",
      );
    const stagedPatch = await gitRaw(
      input.worktreePath,
      [
        ...hookless,
        "diff",
        "--cached",
        "HEAD",
        "--binary",
        "--no-ext-diff",
        "--no-color",
        "--unified=0",
        "--",
      ],
      environment,
    );
    if (hashNormalizedPatch(stagedPatch) !== input.expectedPatchHash)
      throw new MigrationSafetyError(
        "Candidate diff changed after validation",
        8,
        "candidate-diff-changed",
      );
    const unstaged = await gitRaw(
      input.worktreePath,
      [...hookless, "diff", "--name-only", "-z", "--"],
      environment,
    );
    if (unstaged)
      throw new MigrationSafetyError(
        "Candidate files changed while the validated tree was captured",
        8,
        "candidate-diff-changed",
      );

    const tree = await git(
      input.worktreePath,
      [...hookless, "write-tree"],
      environment,
    );
    const candidateCommit = await git(input.worktreePath, [
      "-c",
      `core.hooksPath=${disabledHooks}`,
      "-c",
      "user.name=Braid Migrator",
      "-c",
      "user.email=braid-migrator@example.invalid",
      "commit-tree",
      tree,
      "-p",
      input.baseCommit,
      "-m",
      `braid: execute ${input.proposalId}`,
      "-m",
      `Braid-Proposal: ${input.proposalId}\nBraid-Execution: ${input.executionId}\nBraid-Plan: ${input.planId}`,
    ]);
    await git(input.worktreePath, [
      ...hookless,
      "update-ref",
      "--create-reflog",
      "-m",
      `braid candidate ${input.executionId}`,
      branchRef,
      candidateCommit,
      input.baseCommit,
    ]);
    await git(input.worktreePath, [
      ...hookless,
      "read-tree",
      "--reset",
      candidateCommit,
    ]);

    const [parent, committedTree, status, changedFiles] = await Promise.all([
      git(input.worktreePath, [
        ...hookless,
        "rev-parse",
        `${candidateCommit}^`,
      ]),
      git(input.worktreePath, [
        ...hookless,
        "rev-parse",
        `${candidateCommit}^{tree}`,
      ]),
      git(input.worktreePath, [
        ...hookless,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      gitRaw(input.worktreePath, [
        ...hookless,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        candidateCommit,
      ]),
    ]);
    const committedFiles = changedFiles
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    if (parent !== input.baseCommit || committedTree !== tree)
      throw new MigrationSafetyError(
        "Candidate commit does not contain the validated tree and base parent",
        8,
        "candidate-tree-mismatch",
      );
    if (JSON.stringify(committedFiles) !== JSON.stringify(expectedFiles))
      throw new MigrationSafetyError(
        "Candidate commit files do not match the validated migration scope",
        8,
        "candidate-staging-mismatch",
      );
    if (status)
      throw new MigrationSafetyError(
        "Candidate worktree changed during controlled commit creation",
        8,
        "candidate-post-commit-dirty",
      );
    return candidateCommit;
  } finally {
    await rm(temporaryIndexDirectory, { recursive: true, force: true });
  }
};
